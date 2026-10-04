// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 流光 classic：单行逐词三态。JS 只翻状态/写 CSS 变量，过渡与辉光全交 CSS。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;

  function init(host, onSeek) {
    var root = document.createElement('div'); root.className = 'fl-classic';
    var lineEl = null, emptyEl = null;
    var theme = StanzaTheme.DEFAULT, fontScale = 1, visible = true, paused = false;
    var tuning = { rotation: true, breathing: 1, spacing: 0.7 };
    var curLine = null, curHints = null, measureCanvas = null;
    // soft=true 时下一次 frame 的行切换为"软重建"：配置类变更（主题/调谐/字号/尺寸）只重建节点，
    // 不播 fl-exit/fl-enter，避免拖滑杆时当前行长期半透明模糊与鬼影叠加。
    var softRebuild = false, destroyed = false;

    // 行级转场档位：renderHints 的 timingClass(micro/short/normal) 映射为 stanza 固定转场名(none/fast/normal)。
    // 转场时长是固定常量，与 enterMs/exitMs 无关（normal 400/300、fast 160/160、none 0/120）。
    var LINE_ENTER_DUR = { normal: '400ms', fast: '160ms', none: '0ms' };
    var LINE_EXIT_DUR = { normal: '300ms', fast: '160ms', none: '120ms' };
    var LINE_EXIT_MS = { normal: 300, fast: 160, none: 120 };
    function lineTimingOf(hints) {
      if (hints.timingClass === 'micro') return 'none';
      if (hints.timingClass === 'short') return 'fast';
      return 'normal';
    }

    function fontPx(viewportW) {
      var minPx = 2.25 * fontScale * 16;
      var valPx = 6 * fontScale * viewportW / 100;
      var maxPx = 4.5 * fontScale * 16;
      return Math.max(minPx, Math.min(valPx, maxPx));
    }
    function measure(text, px) {
      if (!measureCanvas) measureCanvas = document.createElement('canvas');
      var ctx = measureCanvas.getContext('2d');
      ctx.font = '700 ' + px + 'px ' + StanzaTheme.fontStack(theme.fontStyle);
      return ctx.measureText(text).width;
    }

    function rand(seed, off) { return U.srand(seed + off); }

    function buildLine(line, soft) {
      if (lineEl) { lineEl.remove(); lineEl = null; }
      var tokens = Stage.lyricTokens(line);
      var isInterlude = !U.hasReadable(line.text);
      var container = document.createElement('div');
      var px = fontPx(global.innerWidth || 1200);
      container.style.fontSize = px + 'px';
      // 呼吸作用于常驻外层 root，避免与行进入/退出动画抢同一元素的 transform。
      root.classList.add('fl-cbreath');
      root.style.setProperty('--fl-breath-amp',
        ((theme.animationIntensity === 'calm' ? 10 : theme.animationIntensity === 'chaotic' ? 18 : 14) * tuning.breathing) + 'px');
      root.style.setProperty('--fl-breath-dur',
        (theme.animationIntensity === 'calm' ? 8.5 : theme.animationIntensity === 'chaotic' ? 5.8 : 7) + 's');
      // 呼吸 scale 幅度随 breathing 乘数变化（±.01m / .005m）。
      root.style.setProperty('--fl-bs1', (0.01 * tuning.breathing) + '');
      root.style.setProperty('--fl-bs2', (0.005 * tuning.breathing) + '');
      root.style.animationPlayState = (tuning.breathing <= 0 || paused) ? 'paused' : 'running';
      container.style.setProperty('--fl-accent', theme.accentColor);
      curHints = U.renderHints(line);
      var lineTiming = lineTimingOf(curHints);
      // soft（配置类软重建）时不挂任何 fl-enter-* 类：新行直接稳态呈现，无进入动画。
      container.className = soft ? 'fl-cline' : 'fl-cline fl-enter-' + lineTiming;
      container.style.setProperty('--fl-line-dur', LINE_ENTER_DUR[lineTiming]);

      var dispTokens = tokens;
      var widths = dispTokens.map(function (w) { return measure(w.text, px); });
      var chaotic = theme.animationIntensity === 'chaotic';
      var calm = theme.animationIntensity === 'calm';
      var narrow = (global.innerWidth || 1200) < 760;
      var baseSpread = (chaotic ? 60 : calm ? 0 : 20) * (narrow ? 0.6 : 1);
      var activeScaleMul = narrow ? 1.28 : 1.4;   // stanza 窄屏收敛
      var seed = line.start_ms;

      // 容器对齐：calm 与间奏固定居中；normal/chaotic 由 seed 随机（justify 5 选 1、align 3 选 1）。
      if (calm || isInterlude) {
        container.style.justifyContent = 'center';
        container.style.alignItems = 'center';
      } else {
        var justs = ['flex-start', 'center', 'flex-end', 'space-around', 'space-between'];
        var aligns = ['flex-start', 'center', 'flex-end'];
        container.style.justifyContent = justs[Math.floor(rand(seed / 1000, 31) * justs.length)];
        container.style.alignItems = aligns[Math.floor(rand(seed / 1000, 32) * aligns.length)];
      }
      // chaotic 容器另加 500–1000px perspective。
      if (chaotic) container.style.perspective = (500 + Math.floor(rand(seed / 1000, 33) * 500)) + 'px';

      dispTokens.forEach(function (w, i) {
        var wordSeed = seed / 1000 + i; // stanza 用秒级 seed
        var r = function (off) { return rand(wordSeed, off); };
        var scaleCfg = chaotic ? 0.8 + r(4) * 0.6 : 1.1 + r(4) * 0.2;
        // 间奏词只有轻微纵向随机（±7.5px），无 x 散布。
        var x, y;
        if (isInterlude) {
          x = 0;
          y = (r(2) - 0.5) * 15;
        } else {
          x = (r(1) - 0.5) * baseSpread * 2;
          y = (r(2) - 0.5) * baseSpread * 2;
        }
        var rotate = tuning.rotation ? (r(3) - 0.5) * (chaotic ? 60 : calm ? 0 : 10) : 0;
        var passedRotate = tuning.rotation ? (r(8) - 0.5) * 45 : 0;
        // 精确词距（stanza 新版排版）
        var wi = widths[i] || 0, si = scaleCfg * activeScaleMul;
        var wnext = 0, snext = 1, xnext = 0;
        if (i + 1 < dispTokens.length) {
          var ns = seed / 1000 + i + 1, nr = function (o) { return rand(ns, o); };
          snext = (chaotic ? 0.8 + nr(4) * 0.6 : 1.1 + nr(4) * 0.2) * activeScaleMul;
          xnext = (nr(1) - 0.5) * baseSpread * 2;
          wnext = widths[i + 1] || 0;
        }
        var gap = 0.05 * px;
        var calc = (wi * (si - 1) / 2 + wnext * (snext - 1) / 2 + (x - xnext) + gap) * tuning.spacing;
        var minM = (chaotic ? 0.08 : 0.12) * px * tuning.spacing;
        var margin = Math.max(minM, calc);

        var wordEl = document.createElement('span');
        wordEl.className = 'fl-cword';
        wordEl.dataset.st = 'waiting';
        wordEl.style.fontSize = px + 'px';
        wordEl.style.fontFamily = StanzaTheme.fontStack(theme.fontStyle);
        wordEl.style.marginRight = (isInterlude ? 48 /* stanza: 3rem */ : margin) + 'px';
        wordEl.style.setProperty('--fl-x', x + 'px');
        wordEl.style.setProperty('--fl-y', y + 'px');
        wordEl.style.setProperty('--fl-rot', rotate + 'deg');
        wordEl._cfg = { x: x, y: y, rotate: rotate, scale: isInterlude ? 1.5 : scaleCfg, passedRotate: passedRotate };
        wordEl._word = w; wordEl._line = line;

        // 旋转分层：glow/body 挂到内层 .fl-crot，外层 wordEl 只承担 translate/scale/opacity。
        var crot = document.createElement('span'); crot.className = 'fl-crot';
        wordEl._crot = crot;
        var glow = document.createElement('span'); glow.className = 'fl-glow';
        var body = document.createElement('span'); body.className = 'fl-body';
        var color = StanzaTheme.wordColor(w.text, theme);
        body.style.color = theme.primaryColor;
        glow.style.setProperty('--fl-accent', color);
        wordEl.style.setProperty('--fl-accent', color);

        // 辉光始终逐字素包 span：单字词语义/动画统一，多字词内联时长/延迟错峰。
        U.graphemeTimings(w).forEach(function (g, gi, all) {
          var gs = document.createElement('span');
          gs.textContent = g.char;
          if (all.length > 1) {
            gs.style.animationDelay = Math.max(0, g.start_ms - w.start_ms) + 'ms';
            gs.style.animationDuration = Math.max(80, (g.end_ms - g.start_ms) * 6) + 'ms';
          }
          glow.append(gs);
        });
        body.textContent = w.text;
        crot.append(glow, body);
        wordEl.append(crot);
        wordEl.addEventListener('click', function (e) {
          e.stopPropagation();
          if (typeof line.start_ms === 'number' && onSeek) onSeek(line.start_ms);
        });
        applyPose(wordEl, 'waiting');
        container.append(wordEl);
      });

      root.append(container);
      lineEl = container;
      lineEl._lineTiming = lineTiming;
      lineEl._tokens = dispTokens;
      lineEl._words = Array.prototype.slice.call(container.querySelectorAll('.fl-cword'));
    }

    function applyPose(el, st) {
      var cfg = el._cfg, crot = el._crot;
      if (st === 'waiting') {
        // stanza 原公式：x + sin(y)·100，y + cos(x)·50（cfg 单位即 px）。
        el.style.transform = 'translate(' + (cfg.x + Math.sin(cfg.y) * 100) + 'px,' +
          (cfg.y + Math.cos(cfg.x) * 50) + 'px) scale(.5)';
        crot.style.transform = 'rotate(' + (cfg.rotate + 20) + 'deg)';
      } else if (st === 'active') {
        var mul = (global.innerWidth || 1200) < 760 ? 1.28 : 1.4;
        el.style.transform = 'translate(' + cfg.x + 'px,' + cfg.y + 'px) scale(' +
          (cfg.scale * mul).toFixed(3) + ')';
        crot.style.transform = 'rotate(' + cfg.rotate + 'deg)';
      } else {
        el.style.transform = 'translate(' + cfg.x + 'px,' + cfg.y + 'px) scale(' +
          cfg.scale.toFixed(3) + ')';
        crot.style.transform = 'rotate(' + (cfg.rotate + cfg.passedRotate) + 'deg)';
        el.style.opacity = theme.animationIntensity === 'chaotic' ? '0.9' : '0.82';
      }
      el.dataset.st = st;
    }

    function buildEmpty() {
      if (emptyEl) return;
      emptyEl = document.createElement('div');
      emptyEl.className = 'fl-empty';
      emptyEl.style.color = theme.secondaryColor;
      emptyEl.style.fontSize = 'clamp(' + (1.5 * fontScale).toFixed(3) + 'rem,' +
        (3.5 * fontScale).toFixed(3) + 'vw,' + (2.25 * fontScale).toFixed(3) + 'rem)';
      emptyEl.textContent = global.Stage && Stage.presentation && Stage.presentation().track ? '暂无歌词 · 让旋律继续' : '在声音里，发现另一片宇宙';
      root.append(emptyEl);
    }

    // 配置类变更（主题/调谐/字号/resize）触发的软重建：标记下一帧按 soft 处理，
    // 旧行立即移除、新行不带进入动画。emptyEl 同步清掉，由下一帧按需重建。
    function rebuildSoft() {
      curLine = null;
      softRebuild = true;
      if (emptyEl) { emptyEl.remove(); emptyEl = null; }
    }

    function frame() {
      if (destroyed) return;
      if (!visible || !global.Stage) return;
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var lines = doc ? doc.lines : [];
      var idx = U.activeLineIndex(lines, tMs);
      var line = idx >= 0 ? lines[idx] : null;
      if (line !== curLine) {
        if (lineEl) {
          if (softRebuild) {
            // 软重建：旧节点立即消失，不挂 fl-exit、不设定时器。
            lineEl.remove();
            lineEl = null;
          } else {
            var old = lineEl;
            var oldTiming = old._lineTiming || 'normal';
            // popLayout：退出行脱离文档流，不挤掉新行的居中位置。
            old.style.position = 'absolute';
            // 退出动画期间禁止再响应点击（新行已可点击，旧行仅作视觉残影）。
            old.style.pointerEvents = 'none';
            old.classList.remove('fl-enter-' + oldTiming);
            old.classList.add('fl-exit-' + oldTiming);
            old.style.setProperty('--fl-line-dur', LINE_EXIT_DUR[oldTiming]);
            setTimeout(function () { old.remove(); }, LINE_EXIT_MS[oldTiming]);
            lineEl = null;
          }
        }
        curLine = line;
        if (line) {
          // 仅在切到非空行时移除 emptyEl；空状态保持期间由 buildEmpty 的守卫避免每帧重建。
          if (emptyEl) { emptyEl.remove(); emptyEl = null; }
          buildLine(line, softRebuild);
        }
        softRebuild = false;
      }
      if (!line) {
        // 空状态下触发的软重建没有行切换可消费标记：emptyEl 重建即落地，标记在此核销，
        // 避免残留到下一次真实换句使其误走 soft（漏播进入动画）。
        softRebuild = false;
        buildEmpty();
        return;
      }
      if (!lineEl || !curHints) return;
      var words = lineEl._words, tokens = lineEl._tokens;
      for (var i = 0; i < words.length; i += 1) {
        var st = U.wordState(tokens[i], curHints, line, tMs);
        if (words[i].dataset.st !== st) {
          var w = tokens[i];
          var mode = curHints.revealMode;
          var wordDur = w.end_ms - w.start_ms;
          words[i].setAttribute('data-reveal', mode);
          // 多字词切 fl-multi（辉光改走 fl-glow-c，字素 span 内联时长/延迟错峰）。
          if (U.graphemeTimings(w).length > 1) words[i].classList.add('fl-multi');
          else words[i].classList.remove('fl-multi');
          // body 染色时长 --fl-dur（最小时长）与辉光时长 --fl-glow-dur 分开。
          var colorDur = mode === 'instant' ? Math.max(wordDur, 80) :
            mode === 'fast' ? Math.max(wordDur, 120) : Math.max(wordDur, 100);
          var glowDur = mode === 'instant' ? Math.min(wordDur, 120) :
            mode === 'fast' ? Math.min(200, Math.max(wordDur, 120)) : Math.max(wordDur, 100);
          words[i].style.setProperty('--fl-dur', Math.round(colorDur) + 'ms');
          words[i].style.setProperty('--fl-glow-dur', Math.round(glowDur) + 'ms');
          words[i].style.setProperty('--fl-blur-dur', mode === 'instant' ? '80ms' : mode === 'fast' ? '120ms' : '200ms');
          words[i].style.setProperty('--fl-color-back', mode === 'instant' ? '120ms' : mode === 'fast' ? '240ms' : '800ms');
          words[i].style.setProperty('--fl-glow-back', mode === 'instant' ? '120ms' : mode === 'fast' ? '220ms' : '900ms');
          words[i].querySelector('.fl-body').style.color = st === 'waiting' ? theme.primaryColor :
            (st === 'active' ? StanzaTheme.wordColor(w.text, theme) : theme.primaryColor);
          if (st !== 'passed') words[i].style.opacity = '';
          applyPose(words[i], st);
        }
      }
    }

    host.append(root);
    return {
      frame: frame,
      // 8fps 元数据 gate：行变更由 frame 依据 Stage 行号自行检测，这里不得重建行。
      update: function () {},
      setTheme: function (t) {
        if (t === theme) return;
        if (global.StanzaTheme && StanzaTheme.signature(t) === StanzaTheme.signature(theme)) return;
        theme = t; rebuildSoft();
      },
      setFontScale: function (v) { v = U.clamp(v, 0.7, 1.5); if (Math.abs(v - fontScale) < 1e-6) return; fontScale = v; rebuildSoft(); },
      setVisible: function (b) { visible = b; root.hidden = !b; },
      setPaused: function (b) {
        paused = b;
        // breathing<=0 归一为 paused：目标 playState 没变就不写 DOM（8fps 空转守卫）。
        var want = (tuning.breathing <= 0 || paused) ? 'paused' : 'running';
        if (want === root.style.animationPlayState) return;
        root.style.animationPlayState = want;
      },
      setEco: function () {},
      setTuning: function (t) {
        var next = { rotation: t.rotation !== false,
          breathing: U.clamp(t.breathing != null ? t.breathing : 1, 0, 2),
          spacing: U.clamp(t.spacing != null ? t.spacing : 0.7, 0, 2) };
        if (next.rotation === tuning.rotation && next.breathing === tuning.breathing && next.spacing === tuning.spacing) return;
        tuning = next; rebuildSoft();
      },
      resize: function () { rebuildSoft(); },
      destroy: function () { destroyed = true; root.remove(); }
    };
  }
  global.StanzaClassic = { init: init };
})(window);
