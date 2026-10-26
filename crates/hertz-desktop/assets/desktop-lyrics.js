(() => {
  "use strict";

  const root = document.documentElement;
  const els = {
    current: document.getElementById("current"),
    secondary: document.getElementById("secondary"),
    notice: document.getElementById("notice"),
    layout: document.getElementById("layout"),
    secondaryBtn: document.getElementById("secondary-btn"),
  };
  const ipc = (payload) => {
    try {
      window.ipc.postMessage(JSON.stringify(payload));
    } catch (_) {
      /* 页面不在宿主里时静默 */
    }
  };

  const state = {
    snapshot: null,
    document: null,
    config: null,
    locked: false,
    active: true,
    source: "waiting",
    sourceMessage: "",
    groups: null,
    anchor: null,
    confirmed: false,
    lastPosition: null,
    lastSession: null,
    lastSeq: -1,
    lastSnapshotAt: 0,
    renderedKey: null,
    renderedGroup: -1,
    renderedText: "",
    renderedSecondary: "",
    renderedLayout: "",
    wordSpans: [],
    lineSpan: null,
    lineTiming: null,
    raf: 0,
    lastPaint: 0,
  };

  function trackId(snapshot) {
    return snapshot && snapshot.track ? snapshot.track.id : null;
  }

  function applyConfig(config) {
    if (!config) return;
    state.config = config;
    root.style.setProperty("--font-family", config.fontFamily);
    root.style.setProperty("--font-size", `${config.fontSize}px`);
    root.style.setProperty("--font-weight", String(config.fontWeight));
    root.style.setProperty("--sung", config.sungColor);
    root.style.setProperty("--unsung", config.unsungColor);
    root.style.setProperty("--outline-color", config.outlineColor);
    root.style.setProperty("--outline-width", `${config.outlineWidth}px`);
    root.style.setProperty("--opacity", String(config.opacity));
    document.body.dataset.layout = config.layout;
    els.layout.textContent = config.layout === "double" ? "单行" : "双行";
    els.secondaryBtn.textContent =
      config.secondary === "translation"
        ? "次行：译文"
        : config.secondary === "romanization"
          ? "次行：罗马音"
          : "次行：下一句";
    els.secondaryBtn.style.display = config.layout === "single" ? "none" : "";
    document.getElementById("font-value").textContent = `${config.fontSize}px`;
    document.getElementById("opacity-value").textContent = `${Math.round(config.opacity * 100)}%`;
    const limits = {
      "font-down": config.fontSize <= 18,
      "font-up": config.fontSize >= 72,
      "opacity-down": config.opacity <= 0.25,
      "opacity-up": config.opacity >= 1,
    };
    Object.keys(limits).forEach((command) => {
      document.querySelector(`[data-cmd="${command}"]`).disabled = limits[command];
    });
    setLocked(config.locked);
    render();
    updateLoop();
  }

  function setLocked(locked) {
    state.locked = Boolean(locked);
    document.body.classList.toggle("locked", state.locked);
    document.body.classList.toggle("unlocked", !state.locked);
    if (state.locked) document.getElementById("lyric-options").open = false;
    scheduleRender();
  }

  function setActive(active) {
    state.active = Boolean(active);
    if (!state.active) {
      stopLoop();
      return;
    }
    render();
    updateLoop();
  }

  function setSource(payload) {
    if (!payload) return;
    state.source = payload.state || "error";
    state.sourceMessage = payload.message || "";
    if (state.source !== "ok") {
      state.document = null;
      state.groups = null;
      state.renderedKey = null;
    }
    render();
  }

  function applySnapshot(snapshot) {
    if (!snapshot) {
      state.snapshot = null;
      state.document = null;
      state.groups = null;
      state.anchor = null;
      state.confirmed = false;
      state.renderedKey = null;
      render();
      stopLoop();
      return;
    }
    if (
      state.lastSession === snapshot.server.session &&
      snapshot.seq <= state.lastSeq
    ) {
      return;
    }
    const previous = state.snapshot;
    const now = performance.now();
    const identityChanged =
      !previous ||
      previous.server.session !== snapshot.server.session ||
      previous.generation !== snapshot.generation ||
      trackId(previous) !== trackId(snapshot);
    const advanced =
      !identityChanged &&
      state.lastPosition != null &&
      snapshot.positionMs > state.lastPosition + 1;
    state.confirmed =
      advanced && snapshot.playing && !snapshot.buffering
        ? true
        : false;
    state.anchor = { position: snapshot.positionMs, at: now };
    state.lastPosition = snapshot.positionMs;
    state.lastSeq = snapshot.seq;
    state.lastSession = snapshot.server.session;
    state.lastSnapshotAt = now;
    if (snapshot.lyrics.status !== "ready") {
      state.document = null;
      state.groups = null;
      state.renderedKey = null;
    } else if (
      state.document &&
      state.document.documentKey &&
      snapshot.lyrics.documentKey &&
      state.document.documentKey !== snapshot.lyrics.documentKey
    ) {
      state.document = null;
      state.groups = null;
      state.renderedKey = null;
    }
    state.snapshot = snapshot;
    render();
    updateLoop();
  }

  function applyDocument(document) {
    if (!document) {
      state.document = null;
      state.groups = null;
      state.renderedKey = null;
      render();
      return;
    }
    if (
      state.snapshot &&
      state.snapshot.lyrics.documentKey &&
      document.documentKey &&
      state.snapshot.lyrics.documentKey !== document.documentKey
    ) {
      return;
    }
    state.document = document;
    state.groups = buildGroups(document.lines || []);
    state.renderedKey = null;
    render();
    updateLoop();
  }

  function buildGroups(lines) {
    const groups = [];
    for (const line of lines) {
      const last = groups[groups.length - 1];
      if (last && last.start === line.startMs) {
        last.lines.push(line);
      } else {
        groups.push({ start: line.startMs, lines: [line] });
      }
    }
    return groups;
  }

  function displayLine(group) {
    if (!group) return null;
    for (let index = group.lines.length - 1; index >= 0; index -= 1) {
      const line = group.lines[index];
      if (line.text && line.text.trim()) return line;
    }
    return null;
  }

  function positionAt(now) {
    const snapshot = state.snapshot;
    if (!snapshot) return null;
    if (now - state.lastSnapshotAt > 2000) return null;
    if (!state.anchor) return snapshot.positionMs;
    if (!snapshot.playing || snapshot.buffering || !state.confirmed) {
      return state.anchor.position;
    }
    const elapsed = Math.min(now - state.anchor.at, 1000);
    const predicted = state.anchor.position + elapsed;
    return snapshot.durationMs != null
      ? Math.min(predicted, snapshot.durationMs)
      : predicted;
  }

  function groupIndex(groups, position) {
    let index = -1;
    for (let i = 0; i < groups.length; i += 1) {
      if (groups[i].start <= position) index = i;
      else break;
    }
    return index;
  }

  function secondaryText(index, line) {
    const mode = state.config ? state.config.secondary : "next";
    if (mode === "translation") return (line && line.translation) || "";
    if (mode === "romanization") return (line && line.romanization) || "";
    const groups = state.groups || [];
    const next = displayLine(groups[index + 1]);
    return next ? next.text : "";
  }

  function placeholder() {
    const snapshot = state.snapshot;
    if (state.source === "waiting") {
      return state.sourceMessage || "等待 Hertz 服务";
    }
    if (state.source === "error") {
      return state.sourceMessage || "歌词来源不可用";
    }
    if (!snapshot) return "等待 Hertz 服务";
    if (!snapshot.track) return "暂无播放";
    const status = snapshot.lyrics ? snapshot.lyrics.status : "idle";
    if (status === "loading") return "正在读取歌词";
    if (status === "too_large") return "桌面歌词暂不支持此文档";
    if (status === "error") return "歌词读取失败，稍后重试";
    if (status === "empty") return "暂无歌词";
    if (status === "ready") return "正在读取歌词";
    return "暂无歌词";
  }

  function render() {
    if (!state.active) return;
    const snapshot = state.snapshot;
    const position = positionAt(performance.now());
    if (state.source !== "ok" || !snapshot || position == null) {
      setNotice(placeholder());
      clearLines();
      return;
    }
    if (!state.document || !state.groups || state.groups.length === 0) {
      setNotice(placeholder());
      clearLines();
      return;
    }
    const index = groupIndex(state.groups, position);
    const line = index >= 0 ? displayLine(state.groups[index]) : null;
    const text = line ? line.text : "♪";
    const secondary = index >= 0 ? secondaryText(index, line) : "";
    const key = state.document.documentKey || "";
    const layout = state.config ? state.config.layout : "double";
    if (
      state.renderedKey !== key ||
      state.renderedGroup !== index ||
      state.renderedText !== text ||
      state.renderedSecondary !== secondary ||
      state.renderedLayout !== layout
    ) {
      rebuildLine(line, text, secondary, index);
      state.renderedKey = key;
      state.renderedGroup = index;
      state.renderedText = text;
      state.renderedSecondary = secondary;
      state.renderedLayout = layout;
    }
    setNotice("");
    paintSweep(position);
  }

  function rebuildLine(line, text, secondary, index) {
    els.current.textContent = "";
    state.wordSpans = [];
    state.lineSpan = null;
    state.lineTiming = null;
    if (!line) {
      els.current.textContent = text;
    } else if (line.words && line.words.length > 0) {
      const words = line.words;
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        const span = document.createElement("span");
        span.className = "sweep w";
        span.textContent = word.text;
        els.current.appendChild(span);
        const nextStart =
          index + 1 < words.length ? words[index + 1].startMs : null;
        state.wordSpans.push({
          el: span,
          start: word.startMs,
          end: word.endMs != null ? word.endMs : nextStart,
          last: word.endMs == null && nextStart == null,
        });
      }
      state.lineTiming = {
        start: line.startMs,
        end: line.endMs,
        next: nextGroupStart(index),
      };
    } else {
      const span = document.createElement("span");
      span.className = "sweep";
      span.textContent = text;
      els.current.appendChild(span);
      state.lineSpan = span;
      state.lineTiming = {
        start: line.startMs,
        end: line.endMs,
        next: nextGroupStart(index),
      };
    }
    els.secondary.textContent = secondary;
  }

  function nextGroupStart(index) {
    const groups = state.groups || [];
    const next = index >= 0 ? groups[index + 1] : null;
    return next ? next.start : null;
  }

  function sweepProgress(position, start, end) {
    if (end == null || end <= start) {
      return position >= start ? 1 : 0;
    }
    return Math.max(0, Math.min(1, (position - start) / (end - start)));
  }

  function paintSweep(position) {
    if (state.lineSpan && state.lineTiming) {
      const duration = state.snapshot ? state.snapshot.durationMs : null;
      const end =
        state.lineTiming.end != null
          ? state.lineTiming.end
          : state.lineTiming.next != null
            ? state.lineTiming.next
            : duration;
      setProgress(
        state.lineSpan,
        sweepProgress(position, state.lineTiming.start, end),
      );
    }
    for (const word of state.wordSpans) {
      let end = word.end;
      if (end == null && word.last) {
        end = state.lineTiming ? state.lineTiming.end || state.lineTiming.next : null;
      }
      setProgress(word.el, sweepProgress(position, word.start, end));
    }
  }

  function setProgress(element, progress) {
    const previous = element.__progress;
    if (previous != null && Math.abs(previous - progress) < 0.004) return;
    element.__progress = progress;
    element.style.setProperty("--p", progress.toFixed(3));
  }

  function setNotice(text) {
    const next = text || "";
    document.getElementById("shell").classList.toggle("is-empty", Boolean(next));
    if (els.notice.textContent !== next) {
      els.notice.textContent = next;
    }
  }

  function clearLines() {
    if (state.wordSpans.length || state.lineSpan || els.current.textContent) {
      els.current.textContent = "";
      els.secondary.textContent = "";
      state.wordSpans = [];
      state.lineSpan = null;
      state.lineTiming = null;
      state.renderedKey = null;
      state.renderedGroup = -1;
      state.renderedText = "";
      state.renderedSecondary = "";
    }
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
      updateLoop();
    });
  }

  function updateLoop() {
    if (
      !state.active ||
      !state.snapshot ||
      !state.snapshot.playing ||
      state.snapshot.buffering ||
      !state.confirmed ||
      !state.document ||
      state.raf
    ) {
      if (
        state.raf &&
        (!state.active ||
          !state.snapshot ||
          !state.snapshot.playing ||
          state.snapshot.buffering ||
          !state.confirmed)
      ) {
        stopLoop();
      }
      return;
    }
    state.raf = requestAnimationFrame(loop);
  }

  function loop(now) {
    state.raf = 0;
    if (!state.active) return;
    const cap = state.config ? Math.max(1, state.config.frameCap || 30) : 30;
    if (now - state.lastPaint >= 1000 / cap - 0.5) {
      state.lastPaint = now;
      render();
    }
    updateLoop();
  }

  function stopLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  window.hertzLyrics = {
    applyConfig,
    applySnapshot,
    applyDocument,
    setLocked,
    setActive,
    setSource,
  };

  document.getElementById("drag").addEventListener("mousedown", (event) => {
    event.preventDefault();
    ipc({ cmd: "drag" });
  });

  document.querySelectorAll("[data-cmd]").forEach((button) => {
    button.addEventListener("click", () => {
      const cmd = button.dataset.cmd;
      if (cmd === "font-up") ipc({ cmd: "font", value: 2 });
      else if (cmd === "font-down") ipc({ cmd: "font", value: -2 });
      else if (cmd === "width-up") ipc({ cmd: "width", value: 48 });
      else if (cmd === "width-down") ipc({ cmd: "width", value: -48 });
      else if (cmd === "opacity-up") ipc({ cmd: "opacity", value: 0.05 });
      else if (cmd === "opacity-down") ipc({ cmd: "opacity", value: -0.05 });
      else ipc({ cmd });
    });
  });

  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const options = document.getElementById("lyric-options");
      if (options.open) {
        options.open = false;
        options.querySelector("summary").focus();
      }
    }
  });
  document.addEventListener("pointerdown", (event) => {
    const options = document.getElementById("lyric-options");
    if (!options.contains(event.target)) options.open = false;
  });
  ipc({ cmd: "ready" });
})();
