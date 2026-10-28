(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const systemTheme = matchMedia('(prefers-color-scheme: light)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const defaults = {
    layout: 'triple', secondary: 'next', theme: 'auto', surface: 'glass', align: 'center',
    bilingual: true, karaoke: true, readabilityBoost: false, fontFamily: 'Segoe UI',
    fontSize: 30, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff',
    outlineColor: '#000000', outlineWidth: 0, opacity: 1, frameCap: 30,
  };
  const state = {
    config: { ...defaults }, snapshot: null, document: null, groups: [], source: 'waiting',
    active: true, locked: false, anchor: null, confirmed: false,
    lastPosition: null, lastSession: null, lastSeq: -1, lastSnapshotAt: 0, lastClockBeacon: -Infinity,
    renderedKey: null, renderedGroup: -99, signature: '', nodes: new Map(), words: [],
    raf: 0, lastPaint: 0, staleTimer: 0, panelFrame: 0, panelHeight: -1,
    optionsOpen: false, hoverTimer: 0, pendingControl: false, controlTimer: 0,
  };
  function ipc(payload) {
    try { window.ipc.postMessage(JSON.stringify(payload)); } catch (_) { /* Browser preview. */ }
  }
  function colorValue(value, fallback) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6,8}$/i.test(text)) return text.slice(0, 7).toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + [...text.slice(1)].map(c => c + c).join('').toLowerCase();
    return fallback;
  }
  function applyTheme() {
    const config = state.config;
    root.style.setProperty('--panel-max-height', `${config.panelMaxHeight || 480}px`);
    const theme = config.theme === 'auto' ? (systemTheme.matches ? 'light' : 'dark') : config.theme;
    document.body.dataset.theme = theme;
    // Neutral defaults follow the theme; explicit custom colors remain user choices.
    for (const [key, variable] of [['sungColor', '--lyric-sung'], ['unsungColor', '--lyric-unsung']]) {
      root.style.setProperty(variable, colorValue(config[key], '#ffffff') === '#ffffff'
        ? (theme === 'light' ? '#0b0d11' : '#ffffff') : config[key]);
    }
  }
  function applyConfig(value) {
    if (!value) return;
    state.config = { ...defaults, ...value };
    const config = state.config;
    for (const [key, variable, suffix] of [
      ['fontFamily', '--font-family', ''], ['fontSize', '--font-size', 'px'],
      ['fontWeight', '--font-weight', ''], ['outlineColor', '--outline-color', ''],
      ['outlineWidth', '--outline-width', 'px'], ['opacity', '--opacity', ''],
    ]) root.style.setProperty(variable, config[key] + suffix);
    for (const key of ['layout', 'surface', 'align', 'bilingual']) document.body.dataset[key] = String(config[key]);
    document.body.dataset.boost = String(config.readabilityBoost);
    document.body.dataset.lowPower = String(config.frameCap <= 15);
    applyTheme();
    document.querySelectorAll('[data-setting]').forEach(button => {
      let value = config[button.dataset.setting];
      if (button.dataset.setting === 'secondary' && value === 'translation') value = 'next';
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
    });
    document.querySelectorAll('[data-toggle]').forEach(button => button.setAttribute('aria-pressed', String(config[button.dataset.toggle])));
    $('secondary-cell').hidden = !config.bilingual;
    $('font-value').textContent = `${config.fontSize}px`;
    $('font-size').value = config.fontSize;
    $('opacity-value').textContent = `${Math.round(config.opacity * 100)}%`;
    $('opacity').value = Math.round(config.opacity * 100);
    $('sung-color').value = colorValue(config.sungColor, '#ffffff');
    $('unsung-color').value = colorValue(config.unsungColor, '#ffffff');
    setLocked(config.locked);
    state.signature = '';
    render();
    scheduleLayout();
    schedulePanelMeasure();
    updateLoop();
  }
  function setLocked(locked) {
    state.locked = Boolean(locked);
    document.body.classList.toggle('locked', state.locked);
    document.body.classList.toggle('unlocked', !state.locked);
    if (state.locked) setOptionsOpen(false, false);
    updateControls();
  }
  function setOptionsOpen(open, restoreFocus = true) {
    open = Boolean(open) && !state.locked && state.active;
    if (state.optionsOpen === open) return;
    state.optionsOpen = open;
    $('options-panel').hidden = !open;
    document.body.classList.toggle('options-open', open);
    $('style-open').setAttribute('aria-expanded', String(open));
    if (open) { $('options-panel').scrollTop = 0; $('options-panel').focus({ preventScroll: true }); }
    else if (restoreFocus) $('style-open').focus({ preventScroll: true });
    schedulePanelMeasure();
  }
  function schedulePanelMeasure() {
    if (state.panelFrame) return;
    state.panelFrame = requestAnimationFrame(() => {
      state.panelFrame = 0;
      const height = state.optionsOpen ? Math.ceil($('options-panel').getBoundingClientRect().height) + 16 : 0;
      if (height === state.panelHeight) return;
      state.panelHeight = height;
      root.style.setProperty('--panel-height', `${height}px`);
      ipc({ cmd: 'panel', value: height });
    });
  }
  function setActive(active) {
    state.active = Boolean(active);
    if (!state.active) { setOptionsOpen(false, false); stopLoop(); }
    else { render(); updateLoop(); }
  }
  function resetDocument() {
    state.document = null;
    state.groups = [];
    state.renderedKey = null;
    clearLines();
  }
  function setSource(payload) {
    state.source = payload?.state || 'error';
    state.lyricsControl = payload?.capabilities?.lyricsControl !== false;
    if (state.source !== 'ok') { resetDocument(); state.confirmed = false; controlDone(); stopLoop(); }
    render();
  }
  function trackId(snapshot) { return snapshot?.track?.id ?? null; }
  function applySnapshot(snapshot) {
    if (!snapshot) {
      state.snapshot = null;
      state.anchor = null;
      state.confirmed = false;
      state.lastSeq = -1;
      state.lastSession = null;
      resetDocument();
      controlDone();
      render(); stopLoop();
      return;
    }
    if (state.lastSession === snapshot.server.session && snapshot.seq <= state.lastSeq) return;
    const previous = state.snapshot;
    const now = performance.now();
    const age = Math.max(0, Number(snapshot.snapshotAgeMs) || 0) + (Number.isFinite(snapshot.pageDispatchMs) ? Math.max(0, now - snapshot.pageDispatchMs) : 0);
    if (age >= 2000 && now - state.lastClockBeacon >= 1000) { state.lastClockBeacon = now; ipc({ cmd: 'clock', value: now }); }
    if (age >= 3000) {
      // A queued snapshot can expire while native keeps receiving fresh data.
      // Retain only the document already bound to this exact identity; it stays
      // invisible until a fresh snapshot confirms the same source and key.
      const sameDocument = previous && previous.server.session === snapshot.server.session
        && trackId(previous) === trackId(snapshot)
        && previous.lyrics?.documentKey === snapshot.lyrics?.documentKey
        && snapshot.lyrics?.status === 'ready';
      if (!sameDocument) resetDocument();
      else clearLines();
      state.snapshot = snapshot;
      state.anchor = null;
      state.confirmed = false;
      state.lastPosition = null;
      state.lastSeq = snapshot.seq;
      state.lastSession = snapshot.server.session;
      state.lastSnapshotAt = now - age;
      clearTimeout(state.staleTimer);
      controlDone(); render(); stopLoop();
      return;
    }
    const trackChanged = previous && (previous.server.session !== snapshot.server.session || trackId(previous) !== trackId(snapshot));
    const identityChanged = !previous || trackChanged || previous.generation !== snapshot.generation
      || previous.lyrics?.documentKey !== snapshot.lyrics?.documentKey;
    state.confirmed = !identityChanged && state.lastPosition != null
      && snapshot.positionMs > state.lastPosition + 1 && snapshot.playing && !snapshot.buffering;
    state.anchor = { position: snapshot.positionMs, at: now };
    state.lastPosition = snapshot.positionMs;
    state.lastSeq = snapshot.seq;
    state.lastSession = snapshot.server.session;
    state.lastSnapshotAt = now - age;
    if (trackChanged || snapshot.lyrics.status !== 'ready'
      || (state.document && state.document.documentKey !== snapshot.lyrics.documentKey)) resetDocument();
    state.snapshot = snapshot;
    if (state.pendingControl && snapshot.generation !== state.controlGeneration) controlDone();
    clearTimeout(state.staleTimer);
    state.staleTimer = setTimeout(() => { render(); stopLoop(); }, Math.max(0, 2020 - age));
    document.body.classList.toggle('playing', Boolean(snapshot.playing));
    $('play').setAttribute('aria-label', snapshot.playing ? '暂停' : '播放');
    if (identityChanged) state.signature = '';
    render(); updateLoop();
  }
  function applyDocument(document) {
    if (!document) { resetDocument(); render(); stopLoop(); return; }
    if (!state.snapshot || document.documentKey !== state.snapshot.lyrics.documentKey) return;
    state.document = document;
    state.groups = [];
    for (const line of document.lines || []) {
      const last = state.groups.at(-1);
      if (last && last.start === line.startMs) last.lines.push(line);
      else state.groups.push({ start: line.startMs, lines: [line] });
    }
    clearLines();
    render(); updateLoop();
  }
  function displayLine(index) {
    const lines = state.groups[index]?.lines || [];
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].text?.trim()) return lines[i];
    return null;
  }
  function positionAt(now) {
    const snapshot = state.snapshot;
    if (!snapshot || now - state.lastSnapshotAt > 2000) return null;
    if (!state.anchor) return snapshot.positionMs;
    if (!snapshot.playing || snapshot.buffering || !state.confirmed) return state.anchor.position;
    const predicted = state.anchor.position + Math.min(now - state.anchor.at, 1000);
    return snapshot.durationMs != null ? Math.min(predicted, snapshot.durationMs) : predicted;
  }
  function groupIndex(position) {
    let lo = 0, hi = state.groups.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (state.groups[mid].start <= position) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  function placeholder() {
    if (state.source !== 'ok' || !state.snapshot) return '正在连接 Hertz 服务';
    if (!state.snapshot.track) return '暂无播放';
    const status = state.snapshot.lyrics?.status;
    if (status === 'loading' || status === 'ready') return '正在读取歌词';
    if (status === 'too_large') return '桌面歌词暂不支持此文档';
    return '暂无歌词';
  }
  function setNotice(text) {
    $('shell').classList.toggle('is-empty', Boolean(text));
    if ($('notice').textContent !== text) $('notice').textContent = text;
  }
  function clearLines() {
    $('lyric-column').replaceChildren();
    state.nodes.clear(); state.words = []; state.signature = ''; state.renderedGroup = -99;
  }
  function lineEnd(index, line) {
    return line?.endMs ?? state.groups[index + 1]?.start ?? state.snapshot?.durationMs ?? null;
  }
  function makeKara(text, word) {
    const span = document.createElement('span'); span.className = word ? 'kara word' : 'kara';
    const base = document.createElement('span'); base.className = 'base'; base.textContent = text;
    const fill = document.createElement('span'); fill.className = 'fill'; fill.textContent = text;
    fill.setAttribute('aria-hidden', 'true');
    span.append(base, fill);
    return span;
  }
  function buildNode(index, active, interlude) {
    const line = displayLine(index);
    const group = document.createElement('div'); group.className = 'lyric-group'; group.dataset.index = index;
    const main = document.createElement('div'); main.className = 'line main';
    const text = document.createElement('span'); text.className = 'lyric-text';
    if (!line || interlude) {
      text.textContent = '· · ·'; main.classList.add('interlude');
    } else if (active && state.config.karaoke && line.words?.length
      && line.words.map(word => word.text).join('') === line.text) {
      line.words.forEach((word, i) => {
        const span = makeKara(word.text, true);
        text.appendChild(span);
        state.words.push({ el: span, start: word.startMs, end: word.endMs ?? line.words[i + 1]?.startMs ?? lineEnd(index, line) });
      });
    } else {
      // LRC without real word times lights as one line, never a fabricated character timeline.
      text.textContent = line.text;
      if (active) text.style.color = 'var(--lyric-sung, var(--text))';
    }
    main.appendChild(text);
    group.appendChild(main);
    const sub = document.createElement('div'); sub.className = 'line sub lyric-text';
    sub.textContent = !interlude && line ? (state.config.secondary === 'romanization' ? line.romanization : line.translation) || '' : '';
    group.appendChild(sub);
    return group;
  }
  function render() {
    if (!state.active) return;
    const position = positionAt(performance.now());
    if (state.source !== 'ok' || !state.snapshot || position == null || !state.document || !state.groups.length) {
      setNotice(position == null && state.snapshot ? '正在等待播放器同步' : placeholder());
      if (state.nodes.size) clearLines();
      updateControls();
      return;
    }
    const index = groupIndex(position);
    const line = displayLine(index);
    const end = lineEnd(index, line);
    const interlude = !line || (end != null && position >= end);
    const signature = [state.document.documentKey, index, state.config.secondary, state.config.karaoke, interlude].join('|');
    if (state.signature !== signature) {
      const previous = state.renderedGroup;
      const animate = previous !== -99 && Math.abs(index - previous) === 1 && !reducedMotion.matches;
      const start = Math.max(-1, index - 3), stop = Math.min(state.groups.length - 1, index + 3);
      state.words = [];
      for (const [key, node] of state.nodes) {
        if (key < start || key > stop || key === index || key === previous || !state.signature) { node.remove(); state.nodes.delete(key); }
      }
      for (let i = start; i <= stop; i++) {
        if (!state.nodes.has(i)) state.nodes.set(i, buildNode(i, i === index, i === index && interlude));
        const node = state.nodes.get(i);
        node.dataset.distance = Math.abs(i - index) > 2 ? 'hidden' : String(i - index);
        $('lyric-column').appendChild(node);
      }
      state.renderedGroup = index;
      state.signature = signature;
      layout(animate ? previous : null);
      if (animate) {
        const main = state.nodes.get(index)?.querySelector('.main');
        main?.classList.add('enter');
      }
    }
    setNotice('');
    for (const word of state.words) {
      const progress = word.end == null || word.end <= word.start ? Number(position >= word.start)
        : Math.max(0, Math.min(1, (position - word.start) / (word.end - word.start)));
      if (word.progress == null || Math.abs(progress - word.progress) >= .003) {
        word.progress = progress; word.el.style.setProperty('--p', `${(progress * 100).toFixed(2)}%`);
        word.el.querySelector('.fill').style.maskImage = progress >= 1 ? 'none' : '';
      }
    }
    updateControls();
  }
  function layout(previous = null) {
    if (!state.nodes.size) return;
    const column = $('lyric-column');
    const groupHeight = state.nodes.values().next().value.offsetHeight;
    const first = Math.min(...state.nodes.keys());
    const visibleCenter = state.config.layout === 'double' ? groupHeight / 2 : 0;
    const center = $('viewport').clientHeight / 2 - groupHeight / 2 - visibleCenter;
    column.style.transition = 'none';
    column.style.transform = `translateY(${center - ((previous ?? state.renderedGroup) - first) * groupHeight}px)`;
    if (previous != null) {
      column.getBoundingClientRect(); // Commit the rebased, bounded column before its next movement.
      column.style.transition = '';
      column.style.transform = `translateY(${center - (state.renderedGroup - first) * groupHeight}px)`;
    }
  }
  let layoutFrame = 0;
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(); });
  }
  function canAnimate() {
    return state.active && state.source === 'ok' && state.snapshot?.playing && !state.snapshot.buffering
      && state.confirmed && state.document && performance.now() - state.lastSnapshotAt < 2000;
  }
  function updateLoop() {
    if (!canAnimate()) { stopLoop(); return; }
    if (!state.raf) state.raf = requestAnimationFrame(loop);
  }
  function loop(now) {
    state.raf = 0;
    if (now - state.lastPaint >= 1000 / Math.max(1, state.config.frameCap) - .5) { state.lastPaint = now; render(); }
    updateLoop();
  }
  function stopLoop() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; }
  function targetLine(delta) {
    const position = positionAt(performance.now());
    if (position == null) return null;
    let index = groupIndex(position) + delta;
    if (delta > 0 && index < 0) index = 0;
    for (; index >= 0 && index < state.groups.length; index += delta) if (displayLine(index)) return state.groups[index].start;
    return null;
  }
  function updateControls() {
    const available = state.lyricsControl !== false && state.active && !state.locked && state.source === 'ok' && state.snapshot?.track && positionAt(performance.now()) != null && !state.pendingControl;
    for (const id of ['play', 'previous', 'next']) $(id).title = state.lyricsControl === false ? 'DBX 来源仅供读取，请在 DBX 中控制播放' : '';
    $('play').disabled = !available;
    $('previous').disabled = !available || targetLine(-1) == null;
    $('next').disabled = !available || targetLine(1) == null;
  }
  function control(cmd, value) {
    if (state.lyricsControl === false || state.locked || state.pendingControl || $('play').disabled) return;
    state.pendingControl = true;
    state.controlGeneration = state.snapshot.generation;
    updateControls();
    ipc({ cmd, ...(value == null ? {} : { value }) });
    state.controlTimer = setTimeout(() => controlDone('操作未完成，请重试或返回播放器'), 4000);
  }
  function controlDone(message = '') {
    // Keep transport disabled until the native feed confirms the resulting generation.
    if (!message && state.pendingControl && state.source === 'ok'
      && state.snapshot?.generation === state.controlGeneration) return;
    clearTimeout(state.controlTimer);
    state.pendingControl = false;
    $('feedback').hidden = !message;
    $('feedback').textContent = message;
    if (message) setTimeout(() => { $('feedback').hidden = true; }, 3000);
    updateControls();
  }
  function changeSetting(target, value) {
    if (state.locked) return;
    if (target === 'layout' || target === 'secondary') ipc({ cmd: target, text: value });
    else ipc({ cmd: 'appearance', target, ...(typeof value === 'number' ? { value } : { text: String(value) }) });
  }
  $('drag').addEventListener('mousedown', event => { if (event.button !== 0 || state.locked) return; event.preventDefault(); ipc({ cmd: 'drag' }); });
  $('stage').addEventListener('mousedown', event => { if (event.button === 0 && !state.locked) { event.preventDefault(); ipc({ cmd: 'drag' }); } });
  $('play').addEventListener('click', () => control(state.snapshot?.playing ? 'pause' : 'play'));
  for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => { const value = targetLine(delta); if (value != null) control('seek', value); });
  document.querySelectorAll('[data-cmd]').forEach(button => button.addEventListener('click', () => {
    if (state.locked) return;
    const cmd = button.dataset.cmd;
    if (cmd === 'width-up' || cmd === 'width-down') ipc({ cmd: 'width', value: cmd === 'width-up' ? 48 : -48 });
    else ipc({ cmd });
  }));
  document.querySelectorAll('[data-setting]').forEach(button => button.addEventListener('click', () => changeSetting(button.dataset.setting, button.dataset.value)));
  document.querySelectorAll('[data-toggle]').forEach(button => button.addEventListener('click', () => changeSetting(button.dataset.toggle, !state.config[button.dataset.toggle])));
  $('font-size').addEventListener('input', event => changeSetting('fontSize', Number(event.target.value)));
  $('opacity').addEventListener('input', event => changeSetting('opacity', Number(event.target.value) / 100));
  document.querySelectorAll('[data-color]').forEach(input => input.addEventListener('input', () => ipc({ cmd: 'color', target: input.dataset.color, text: input.value })));
  $('style-open').addEventListener('click', () => setOptionsOpen(!state.optionsOpen));
  $('options-done').addEventListener('click', () => setOptionsOpen(false));
  document.addEventListener('pointerdown', event => { if (state.optionsOpen && !event.target.closest('#options-panel, #style-open')) setOptionsOpen(false, false); });
  root.addEventListener('pointerenter', () => { clearTimeout(state.hoverTimer); document.body.classList.add('hovering'); });
  root.addEventListener('pointerleave', () => { clearTimeout(state.hoverTimer); state.hoverTimer = setTimeout(() => document.body.classList.remove('hovering'), 160); });
  $('lyric-column').addEventListener('animationend', event => event.target.classList.remove('enter'));
  systemTheme.addEventListener('change', applyTheme);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(schedulePanelMeasure).observe($('options-panel'));
    new ResizeObserver(scheduleLayout).observe($('viewport'));
  }
  document.fonts?.ready.then(scheduleLayout);
  document.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => {
    if (state.locked) return;
    if (event.key === 'Escape') { event.preventDefault(); if (state.optionsOpen) setOptionsOpen(false); else ipc({ cmd: 'hide' }); return; }
    if (event.target.closest('input, button, select, textarea, [contenteditable]')) return;
    if (event.code === 'Space') { event.preventDefault(); control(state.snapshot?.playing ? 'pause' : 'play'); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const value = targetLine(event.key === 'ArrowLeft' ? -1 : 1); if (value != null) { event.preventDefault(); control('seek', value); } }
    else if (event.key.toLowerCase() === 'l') ipc({ cmd: 'lock' });
  });
  window.hertzLyrics = { applyConfig, applySnapshot, applyDocument, setLocked, setActive, setSource, controlDone, setOptions: open => setOptionsOpen(open, false) };
  applyConfig(defaults);
  ipc({ cmd: 'ready', value: performance.now() });
})();
