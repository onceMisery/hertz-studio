// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// 底部字幕条：当前行翻译（空档驻留上一行）/ 下两句预告。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.FoliaUtil;

  function init(host) {
    var card = document.createElement('div');
    card.className = 'fl-sub-card';
    var glow = document.createElement('div'); glow.className = 'fl-sub-glow'; glow.hidden = true;
    var text = document.createElement('div'); text.className = 'fl-sub-text';
    card.append(glow, text);
    host.append(card);

    function paintGlow() {
      glow.style.background = 'radial-gradient(ellipse 115% 130% at center,' +
        U.withAlpha(theme.backgroundColor, 0.96) + ' 0%,' +
        U.withAlpha(theme.backgroundColor, 0.78) + ' 62%,transparent 100%)';
    }

    var theme = FoliaTheme.DEFAULT, visible = true, fontScale = 1, glowBg = true;
    var lastKey = '';
    var destroyed = false;

    // 直接复刻 folia 的 clamp：min / vw / max 三段
    function fs(minRem, vw, maxRem) {
      return 'clamp(' + (minRem * fontScale).toFixed(3) + 'rem,' + (vw * fontScale).toFixed(3) + 'vw,' +
        (maxRem * fontScale).toFixed(3) + 'rem)';
    }

    function upcomingLines(lines, index, tMs) {
      var out = [];
      if (index >= 0) {
        for (var i = index + 1; i < lines.length && out.length < 2; i += 1) {
          if (U.hasReadable(lines[i].text)) out.push(lines[i]);
        }
      } else {
        for (var j = 0; j < lines.length && out.length < 2; j += 1) {
          if (lines[j].start_ms > tMs && U.hasReadable(lines[j].text)) out.push(lines[j]);
        }
      }
      return out;
    }

    // 翻译读取防御：Stage 未提供 lyricTranslation 时按 null 处理（无翻译）。
    function trAt(i) {
      return typeof Stage.lyricTranslation === 'function' ? Stage.lyricTranslation(i) : null;
    }

    function update() {
      if (destroyed) return;
      if (!visible || !global.Stage) { host.hidden = true; return; }
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var lines = doc ? doc.lines : [];
      // 自算活动行：不信任歌词文档自带的 index（未定位时被规整为 0）；空档自然停在上一行，呈 passed 驻留。
      var index = U.activeLineIndex(lines, tMs);
      var content = null, kind = 'trans';
      var tr = index >= 0 ? trAt(index) : null;
      if (U.hasReadable(tr)) {
        content = [{ t: tr, next: false }];
      }
      if (!content) {
        var ups = upcomingLines(lines, index, tMs);
        if (ups.length) { content = ups.map(function (l) { return { t: l.text, next: true }; }); kind = 'next'; }
      }
      var key = content ? content.map(function (c) { return c.t; }).join('|') + ':' + kind : 'empty';
      if (key === lastKey) return;
      lastKey = key;
      text.innerHTML = '';
      glow.hidden = !glowBg;
      if (glowBg) paintGlow();
      if (!content) { host.hidden = true; return; }
      host.hidden = false;
      content.forEach(function (c) {
        var div = document.createElement('div');
        div.className = 'fl-sub-anim' + (c.next ? ' fl-sub-next' : '');
        div.style.color = theme.secondaryColor;
        div.style.fontFamily = FoliaTheme.fontStack(theme.fontStyle);
        div.style.fontSize = fs(c.next ? 0.875 : 1.125, c.next ? 2 : 2.6, c.next ? 1 : 1.25);
        div.textContent = c.t;
        text.append(div);
      });
    }

    return {
      update: update,
      setTheme: function (t) {
        if (t === theme) return;
        if (global.FoliaTheme && FoliaTheme.signature(t) === FoliaTheme.signature(theme)) return;
        theme = t; lastKey = ''; paintGlow();
      },
      setFontScale: function (v) { if (Math.abs(v - fontScale) < 1e-6) return; fontScale = v; lastKey = ''; },
      setVisible: function (b) { if (b === visible) return; visible = b; host.hidden = !b; if (b) lastKey = ''; },
      setGlowBackground: function (b) { if (b === glowBg) return; glowBg = b; lastKey = ''; },
      setPaused: function () {}, setEco: function () {}, resize: function () { lastKey = ''; },
      destroy: function () { destroyed = true; card.remove(); }
    };
  }
  global.FoliaSubtitle = { init: init };
})(window);
