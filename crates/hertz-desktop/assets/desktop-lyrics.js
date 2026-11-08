(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const systemTheme = matchMedia('(prefers-color-scheme: light)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const defaults = {
    layout: 'single', secondary: 'next', theme: 'auto', surface: 'bare', align: 'center',
    bilingual: false, showVocals: true, karaoke: true, readabilityBoost: false, fontFamily: 'Segoe UI',
    fontSize: 30, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff',
    outlineColor: '#000000', outlineWidth: 0, opacity: 1, frameCap: 30,
  };
  const state = {
    config: { ...defaults }, snapshot: null, document: null, groups: [], source: 'waiting',
    active: true, locked: false, anchor: null, confirmed: false,
    lastPosition: null, lastSession: null, lastSeq: -1, lastSnapshotAt: 0, lastClockBeacon: -Infinity,
    renderedKey: null, renderedGroup: -99, signature: '', nodes: new Map(), words: [],
    raf: 0, lastPaint: 0, staleTimer: 0, panelFrame: 0, panelHeight: -1,
    fitFrame: 0, fitWidth: 0, toolbarWidth: 0,
    events: [], eventCursor: 0, activeLines: new Set(), intervalPosition: null, sortedActive: [],
    lineMeta: [], geometry: null, seekRebuild: false, geometryMeasure: 0, sourceMessage: '',
    optionsOpen: false, hoverTimer: 0, pendingControl: false, controlTimer: 0,
    calibrationPending: false, calibrationIdentity: '', calibrationMessage: '', calibrationFailed: false,
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
    root.style.setProperty('--vocal-label-size', `${Math.max(12, config.fontSize * .46)}px`);
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
    if (validGeometry(config.vocalGeometry)) {
      state.geometry = config.vocalGeometry;
      setGeometryStyle(state.geometry);
    }
    state.signature = '';
    state.fitWidth = 0;
    render();
    scheduleLayout();
    schedulePanelMeasure();
    scheduleFit();
    scheduleVocalMeasure();
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
    scheduleFit();
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
  // offsetWidth 不受邻居行的 scale 变换影响；临时 max-content 只在本帧内存在，不会画出来。
  function naturalWidth(el, css) {
    const before = el.getAttribute('style');
    el.setAttribute('style', `${before || ''};${css}`);
    const width = el.offsetWidth;
    if (before == null) el.removeAttribute('style'); else el.setAttribute('style', before);
    return width;
  }
  function visibleDistances() {
    if (isVocalDocument()) return ['0'];
    if (state.config.layout === 'triple') return ['-1', '0', '1'];
    if (state.config.layout === 'double') return ['0', '1'];
    return ['0'];
  }
  function fitRequiredWidth() {
    const shell = $('shell');
    const style = getComputedStyle(shell);
    const chrome = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    let content = 0;
    if (shell.classList.contains('is-empty')) {
      content = naturalWidth($('notice'), 'width:max-content;padding:0;') + chrome;
    } else {
      const visible = visibleDistances();
      for (const node of state.nodes.values()) {
        if (!visible.includes(node.dataset.distance)) continue;
        content = Math.max(content, naturalWidth(node, 'width:max-content;') + chrome);
      }
    }
    const toolbar = $('toolbar').offsetWidth;
    // 锁定后工具条 display:none 读不到宽度，用历史最大值兜底，避免窗口在锁定时突然变窄。
    if (toolbar) state.toolbarWidth = Math.max(state.toolbarWidth, toolbar);
    let required = Math.max(content, state.toolbarWidth + 12);
    // 面板实测宽度会被当前窗口反过来压窄，所以按它的 CSS 目标宽度 320 + 左右 16 留白来要。
    if (state.optionsOpen) required = Math.max(required, 352);
    return Math.ceil(required);
  }
  function scheduleFit() {
    if (state.fitFrame) return;
    state.fitFrame = requestAnimationFrame(() => {
      state.fitFrame = 0;
      const required = fitRequiredWidth();
      // 变宽必须立刻跟上否则裁字；收窄要攒够 24 DIP 才动，免得每句都抖一次窗口。
      if (state.fitWidth && required <= state.fitWidth + 2 && required >= state.fitWidth - 24) return;
      state.fitWidth = required;
      ipc({ cmd: 'fit', value: required });
    });
  }
  function setActive(active) {
    state.active = Boolean(active);
    if (!state.active) { setOptionsOpen(false, false); stopLoop(); }
    else { render(); updateLoop(); }
  }
  function calibrationIdentity(snapshot) { return snapshot ? [snapshot.server?.session,trackId(snapshot),snapshot.generation].join('|') : ''; }
  function calibrationDone(reply) {
    state.calibrationPending = false;
    const result = reply?.state || 'timeout';
    const messages = {
      shown: '校准控件已在当前播放器中打开', cancelled: '',
      'permission-required': '请在当前播放器中允许从桌面打开校准',
      'receiver-unavailable': '请先打开当前播放器界面或工作台',
      'track-changed': '当前歌曲已变化，请同步后重试',
      'focus-unavailable': '校准界面已打开，但未能切到前台，请在播放器中查看',
      'room-active': '请在一起听房间内校准歌词',
      'lyrics-unavailable': '这首歌暂时没有可校准的歌词',
      'build-mismatch': '播放器与桌面组件不配套，请安装对应组件或一起更新',
      'locked': '请从托盘解锁桌面歌词后重试',
      'source-stale': '等待当前来源同步后重试',
      'capability-unavailable': '当前播放器不支持校准入口，请更新配套版本',
      timeout: '未确认校准界面已打开，请重试',
    };
    state.calibrationMessage = messages[result] ?? messages.timeout;
    state.calibrationFailed = !['shown', 'cancelled'].includes(result);
    updateCalibration(); schedulePanelMeasure();
  }
  function updateCalibration() {
    const identity = calibrationIdentity(state.snapshot);
    if (state.calibrationPending && identity !== state.calibrationIdentity) {
      state.calibrationPending = false; state.calibrationMessage = ''; ipc({ cmd: 'calibration-cancel' });
    }
    const capability = state.snapshot?.lyricsCalibration;
    const current = state.active && !state.locked && state.snapshot && performance.now() - state.lastSnapshotAt < 2000;
    const available = current && capability?.version === 1 && capability.available === true && state.snapshot.lyrics?.status === 'ready';
    $('calibrate').disabled = state.calibrationPending || !available;
    $('calibrate').textContent = state.calibrationPending ? '正在打开' : state.calibrationFailed ? '重试在播放器校准' : '在播放器校准';
    $('calibrate').setAttribute('aria-busy', String(state.calibrationPending));
    const reason = !state.snapshot ? '请先连接当前播放器' : !current ? '等待当前来源同步' : !capability ? '当前播放器不支持校准入口，请更新配套版本'
      : ({ 'permission-required': '请在当前播放器中允许从桌面打开校准', 'receiver-unavailable': '请先打开当前播放器界面或工作台',
        'track-changed': '请先播放一首歌曲', 'lyrics-unavailable': '这首歌暂时没有可校准的歌词', 'room-active': '请在一起听房间内校准歌词' })[capability.reason] || '';
    $('calibration-help').textContent = state.calibrationPending ? '正在打开当前歌曲的校准控件' : state.calibrationMessage || reason || '在当前播放器中调整这首歌的歌词时间';
    $('calibration-help').dataset.error = String(state.calibrationFailed);
  }
  function resetDocument() {
    state.document = null;
    state.groups = [];
    state.events = []; state.activeLines.clear(); state.sortedActive = []; state.lineMeta = [];
    state.eventCursor = 0; state.intervalPosition = null; state.seekRebuild = true;
    document.body.dataset.vocals = 'false';
    document.body.dataset.vocalSingle = 'false';
    $('layout-note').hidden = true;
    state.renderedKey = null;
    clearLines();
  }
  function setSource(payload) {
    state.source = payload?.state || 'error';
    state.sourceMessage = String(payload?.message || '').slice(0, 512);
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
    if (identityChanged) { state.signature = ''; state.seekRebuild = true; }
    render(); updateLoop();
  }
  function applyDocument(document) {
    if (!document) { resetDocument(); render(); stopLoop(); return; }
    if (state.source !== 'ok' || !state.snapshot || state.snapshot.lyrics?.status !== 'ready'
      || document.documentKey !== state.snapshot.lyrics.documentKey) return;
    // Native HTTP and DBX share full validation. The embedded page also refuses
    // unknown schema instead of silently applying the ordinary recent-start path.
    if ((document.vocalSchemaVersion != null && document.vocalSchemaVersion !== 1)
      || (document.lines || []).some(line => line.vocal) && document.vocalSchemaVersion !== 1) {
      resetDocument(); state.snapshot.lyrics.status = 'unsupported';
      render(); stopLoop(); return;
    }
    state.document = document;
    state.groups = [];
    for (const line of document.lines || []) {
      const last = state.groups.at(-1);
      if (last && last.start === line.startMs) last.lines.push(line);
      else state.groups.push({ start: line.startMs, lines: [line] });
    }
    if (isVocalDocument()) buildIntervalIndex();
    window.document.body.dataset.vocals = String(isVocalDocument());
    $('layout-note').hidden = !isVocalDocument();
    clearLines();
    scheduleVocalMeasure();
    render(); updateLoop();
  }
  function isVocalDocument() { return state.document?.vocalSchemaVersion === 1; }
  function fontKey() {
    const c = state.config;
    return [c.fontFamily, c.fontSize, c.fontWeight, c.outlineWidth].join('|');
  }
  function geometryMatches() {
    const g = state.geometry;
    return g && g.documentKey === state.document?.documentKey && g.fontKey === fontKey()
      && g.showVocals === state.config.showVocals && g.bilingual === state.config.bilingual;
  }
  function validGeometry(geometry) {
    return Boolean(geometry && Number.isInteger(geometry.capacity) && geometry.capacity >= 0 && geometry.capacity <= 4
      && Number.isFinite(geometry.slotHeight) && geometry.slotHeight >= 0
      && geometry.fontKey === fontKey() && geometry.showVocals === state.config.showVocals
      && geometry.bilingual === state.config.bilingual
      && (!state.snapshot || geometry.documentKey === state.snapshot.lyrics?.documentKey));
  }
  function setGeometryStyle(geometry) {
    root.style.setProperty('--vocal-slot-height', `${geometry.slotHeight}px`);
    root.style.setProperty('--vocal-line-height', `${Math.max(0, (geometry.slotHeight - 8) / 2)}px`);
  }
  function applyGeometry(geometry) {
    if (!validGeometry(geometry)) return;
    state.geometry = geometry;
    if (isVocalDocument() && geometryMatches()) {
      setGeometryStyle(geometry);
      state.signature = ''; render(); scheduleLayout();
    }
  }
  function scheduleVocalMeasure() {
    if (!isVocalDocument() || state.geometryMeasure) return;
    state.geometryMeasure = requestAnimationFrame(() => {
      state.geometryMeasure = 0;
      if (!isVocalDocument()) return;
      const c = state.config, context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = `${c.fontWeight} ${c.fontSize}px ${JSON.stringify(c.fontFamily)}, "Microsoft YaHei UI", sans-serif`;
      const metrics = context.measureText('国ÅÉgj');
      const height = Math.ceil(2 * Math.max(c.fontSize * 1.32,
        (metrics.fontBoundingBoxAscent || 0) + (metrics.fontBoundingBoxDescent || 0) + c.outlineWidth * 2,
        (metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0) + c.outlineWidth * 2) + 8);
      ipc({ cmd: 'vocal-measure', text: state.document.documentKey, target: fontKey(), value: height });
    });
  }
  function buildIntervalIndex() {
    const agents = new Map(), duplicateNames = new Map();
    for (const [index, agent] of (state.document.agents || []).entries()) {
      agents.set(agent.id, { ...agent, index });
      if (agent.name) duplicateNames.set(agent.name, (duplicateNames.get(agent.name) || 0) + 1);
    }
    state.events = []; state.activeLines.clear(); state.sortedActive = []; state.lineMeta = [];
    state.eventCursor = 0; state.intervalPosition = null; state.seekRebuild = true;
    for (const [index, line] of state.document.lines.entries()) {
      const ids = line.vocal?.agentIds || [];
      state.lineMeta.push({
        rank: line.vocal?.role === 'backing' ? 1 : line.vocal ? 0 : 2,
        agent: agents.get(ids[0])?.index ?? Number.MAX_SAFE_INTEGER,
        label: ids.map(id => {
          const agent = agents.get(id);
          return agent?.name ? (duplicateNames.get(agent.name) > 1 ? `${agent.name} (${id})` : agent.name) : id;
        }).join(' / '),
      });
      if (line.endMs > line.startMs) {
        state.events.push({ at: line.startMs, index, start: true }, { at: line.endMs, index, start: false });
      }
    }
    state.events.sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start) || a.index - b.index);
  }
  function activeIntervals(position) {
    let changed = false;
    if (state.seekRebuild || state.intervalPosition == null || position < state.intervalPosition) {
      state.activeLines.clear();
      state.document.lines.forEach((line, index) => {
        if (line.startMs <= position && position < line.endMs) state.activeLines.add(index);
      });
      let lo = 0, hi = state.events.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (state.events[mid].at <= position) lo = mid + 1; else hi = mid; }
      state.eventCursor = lo; changed = true;
    } else {
      while (state.eventCursor < state.events.length && state.events[state.eventCursor].at <= position) {
        const event = state.events[state.eventCursor++];
        if (event.start) state.activeLines.add(event.index); else state.activeLines.delete(event.index);
        changed = true;
      }
    }
    state.intervalPosition = position; state.seekRebuild = false;
    if (changed) state.sortedActive = [...state.activeLines].sort((a, b) => {
      const x = state.lineMeta[a], y = state.lineMeta[b];
      return x.rank - y.rank || x.agent - y.agent || a - b;
    });
    return state.sortedActive;
  }
  function makeVocalSlot(index, secondary) {
    const line = state.document.lines[index];
    const node = document.createElement('div');
    node.className = `vocal-slot line ${secondary ? 'sub' : 'main'}`;
    node.dataset.index = index; node.dataset.distance = '0'; node.dataset.kind = secondary ? 'secondary' : 'body';
    node._words = [];
    if (!secondary && state.lineMeta[index].label) {
      const label = document.createElement('span'); label.className = 'vocal-label';
      label.textContent = state.lineMeta[index].label; label.title = state.lineMeta[index].label;
      label.setAttribute('aria-label', state.lineMeta[index].label); node.appendChild(label);
    }
    const text = document.createElement('span'); text.className = 'lyric-text';
    if (secondary) text.textContent = (state.config.secondary === 'romanization' ? line.romanization : line.translation) || '';
    else if (state.config.karaoke && line.words?.length && line.words.length <= 64
      && line.words.map(word => word.text).join('') === line.text) {
      line.words.forEach((word, i) => {
        const span = makeKara(word.text, true); text.appendChild(span);
        node._words.push({ el: span, fill: span.querySelector('.fill'), start: word.startMs,
          end: word.endMs ?? line.words[i + 1]?.startMs ?? line.endMs });
      });
    } else { text.textContent = line.text; text.style.color = 'var(--lyric-sung, var(--text))'; }
    node.appendChild(text); return node;
  }
  function renderVocals(position) {
    document.body.dataset.vocalSingle = String(!state.config.showVocals);
    if (!geometryMatches()) { if (state.nodes.size) clearLines(); setNotice('正在调整歌词窗口'); return; }
    const capacity = state.geometry.capacity;
    root.style.setProperty('--vocal-slot-height', `${state.geometry.slotHeight}px`);
    const active = activeIntervals(position);
    if (capacity === 0) {
      if (state.nodes.size) clearLines(); setNotice('空间不足，请调整字号或屏幕设置'); return;
    }
    const bodies = active.slice(0, state.config.showVocals ? capacity : 1);
    const secondary = new Set(); let remaining = capacity - bodies.length;
    if (state.config.bilingual) for (const index of bodies) {
      if (remaining <= 0) break;
      const line = state.document.lines[index];
      if (state.config.secondary === 'romanization' ? line.romanization : line.translation) { secondary.add(index); remaining--; }
    }
    const slots = bodies.flatMap(index => [{ index, secondary: false }, ...(secondary.has(index) ? [{ index, secondary: true }] : [])]);
    const omitted = state.config.showVocals ? active.length - bodies.length : 0;
    const warning = state.config.showVocals ? [capacity < 4 ? '空间不足' : '', omitted > 0 ? `还有${omitted}行` : ''].filter(Boolean).join(' · ') : '';
    const styleKey = `${state.config.karaoke}|${state.config.secondary}`;
    const signature = `${state.document.documentKey}|${slots.map(slot => `${slot.index}:${slot.secondary}`).join(',')}|${styleKey}`;
    if (state.signature !== signature) {
      const wanted = new Set(slots.map(slot => `${state.document.documentKey}:${slot.index}:${slot.secondary ? 'secondary' : 'body'}`));
      for (const [key, node] of state.nodes) if (!wanted.has(key) || node._styleKey !== styleKey) { node.remove(); state.nodes.delete(key); }
      state.words = [];
      for (const slot of slots) {
        const key = `${state.document.documentKey}:${slot.index}:${slot.secondary ? 'secondary' : 'body'}`;
        let node = state.nodes.get(key);
        if (!node) { node = makeVocalSlot(slot.index, slot.secondary); node._styleKey = styleKey; state.nodes.set(key, node); }
        $('lyric-column').appendChild(node); state.words.push(...node._words);
      }
      state.signature = signature; layout();
    }
    $('vocal-capacity').hidden = !warning;
    if ($('vocal-capacity').textContent !== warning) $('vocal-capacity').textContent = warning;
    setNotice(bodies.length ? '' : '· · ·');
    paintWords(position);
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
    if (state.source !== 'ok' || !state.snapshot) return state.sourceMessage || '正在连接 Hertz 服务';
    if (!state.snapshot.track) return '暂无播放';
    const status = state.snapshot.lyrics?.status;
    if (status === 'unsupported') return '当前桌面歌词组件不支持此歌词，请更新组件';
    if (status === 'invalid') return '歌词内容无效，请在播放器中重新导入';
    if (status === 'loading' || status === 'ready') return '正在读取歌词';
    if (status === 'too_large') return '桌面歌词暂不支持此文档';
    return '暂无歌词';
  }
  function setNotice(text) {
    const shell = $('shell');
    const wasEmpty = shell.classList.contains('is-empty');
    shell.classList.toggle('is-empty', Boolean(text));
    const textChanged = $('notice').textContent !== text;
    if (textChanged) $('notice').textContent = text;
    if (textChanged || wasEmpty !== Boolean(text)) scheduleFit();
  }
  function clearLines() {
    $('lyric-column').replaceChildren();
    state.nodes.clear(); state.words = []; state.signature = ''; state.renderedGroup = -99;
    $('vocal-capacity').textContent = ''; $('vocal-capacity').hidden = true;
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
    if (isVocalDocument()) { renderVocals(position); updateControls(); return; }
    const index = groupIndex(position);
    const line = displayLine(index);
    const end = lineEnd(index, line);
    const interlude = !line || (end != null && position >= end);
    const signature = [state.document.documentKey, index, state.config.secondary, state.config.karaoke, interlude].join('|');
    if (state.signature !== signature) {
      const previous = state.renderedGroup;
      const animate = previous !== -99 && Math.abs(index - previous) === 1 && canAnimate() && !state.seekRebuild && !reducedMotion.matches;
      const start = Math.max(-1, index - 3), stop = Math.min(state.groups.length - 1, index + 3);
      state.words = [];
      for (const [key, node] of state.nodes) {
        if (key < start || key > stop || key === index || key === previous || !state.signature) { node.remove(); state.nodes.delete(key); }
      }
      for (let i = start; i <= stop; i++) {
        if (!state.nodes.has(i)) state.nodes.set(i, buildNode(i, i === index, i === index && interlude));
        const node = state.nodes.get(i);
        const distance = Math.abs(i - index) > 2 ? 'hidden' : String(i - index);
        node.dataset.distance = distance;
        // 读屏只读当前行：淡出/隐藏的邻行不进无障碍树，与视觉可见性一致。
        node.setAttribute('aria-hidden', String(distance !== '0'));
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
    state.seekRebuild = false;
    paintWords(position);
    updateControls();
  }
  function paintWords(position) {
    for (const word of state.words) {
      const progress = word.end == null || word.end <= word.start ? Number(position >= word.start)
        : Math.max(0, Math.min(1, (position - word.start) / (word.end - word.start)));
      if (word.progress == null || Math.abs(progress - word.progress) >= .003) {
        word.progress = progress; word.el.style.setProperty('--p', `${(progress * 100).toFixed(2)}%`);
        (word.fill || word.el.querySelector('.fill')).style.maskImage = progress >= 1 ? 'none' : '';
      }
    }
  }
  function layout(previous = null) {
    if (!state.nodes.size) return;
    if (isVocalDocument()) {
      $('lyric-column').style.transition = 'none'; $('lyric-column').style.transform = 'none';
      scheduleFit(); return;
    }
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
    scheduleFit();
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
    const cap = Math.min(reducedMotion.matches || state.config.frameCap <= 15 ? 15 : 30, Math.max(1, state.config.frameCap));
    if (now - state.lastPaint >= 1000 / cap - .5) { state.lastPaint = now; render(); }
    updateLoop();
  }
  function stopLoop() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; }
  function targetLine(delta) {
    const position = positionAt(performance.now());
    if (position == null) return null;
    let index = groupIndex(position) + delta;
    if (delta > 0 && index < 0) index = 0;
    if (isVocalDocument()) return state.groups[index]?.start ?? null;
    for (; index >= 0 && index < state.groups.length; index += delta) if (displayLine(index)) return state.groups[index].start;
    return null;
  }
  function updateControls() {
    updateCalibration();
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
  $('calibrate').addEventListener('click', () => {
    updateCalibration();
    if ($('calibrate').disabled) return;
    state.calibrationPending = true; state.calibrationIdentity = calibrationIdentity(state.snapshot); state.calibrationMessage = ''; state.calibrationFailed = false;
    updateCalibration(); ipc({ cmd: 'calibrate' });
  });
  document.addEventListener('pointerdown', event => { if (state.optionsOpen && !event.target.closest('#options-panel, #style-open')) setOptionsOpen(false, false); });
  root.addEventListener('pointerenter', () => { clearTimeout(state.hoverTimer); document.body.classList.add('hovering'); });
  root.addEventListener('pointerleave', () => { clearTimeout(state.hoverTimer); state.hoverTimer = setTimeout(() => document.body.classList.remove('hovering'), 160); });
  $('lyric-column').addEventListener('animationend', event => event.target.classList.remove('enter'));
  systemTheme.addEventListener('change', applyTheme);
  reducedMotion.addEventListener('change', updateLoop);
  const observers = [];
  if (typeof ResizeObserver === 'function') {
    const panel = new ResizeObserver(schedulePanelMeasure), viewport = new ResizeObserver(scheduleLayout);
    panel.observe($('options-panel')); viewport.observe($('viewport')); observers.push(panel, viewport);
  }
  document.fonts?.ready.then(() => { scheduleLayout(); scheduleFit(); scheduleVocalMeasure(); });
  document.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => {
    if (state.locked) return;
    if (event.key === 'Escape') { event.preventDefault(); if (state.optionsOpen) setOptionsOpen(false); else ipc({ cmd: 'hide' }); return; }
    if (event.target.closest('input, button, select, textarea, [contenteditable]')) return;
    if (event.code === 'Space') { event.preventDefault(); control(state.snapshot?.playing ? 'pause' : 'play'); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const value = targetLine(event.key === 'ArrowLeft' ? -1 : 1); if (value != null) { event.preventDefault(); control('seek', value); } }
    else if (event.key.toLowerCase() === 'l') ipc({ cmd: 'lock' });
  });
  window.addEventListener('pagehide', () => {
    if (state.calibrationPending) ipc({ cmd: 'calibration-cancel' });
    state.active = false; stopLoop(); resetDocument(); state.snapshot = null; state.anchor = null; state.geometry = null;
    for (const timer of [state.staleTimer, state.hoverTimer, state.controlTimer]) clearTimeout(timer);
    for (const frame of [state.panelFrame, state.fitFrame, state.geometryMeasure, layoutFrame]) cancelAnimationFrame(frame);
    observers.forEach(observer => observer.disconnect());
    systemTheme.removeEventListener('change', applyTheme); reducedMotion.removeEventListener('change', updateLoop);
  });
  window.hertzLyrics = { applyConfig, applySnapshot, applyDocument, applyGeometry, setLocked, setActive, setSource, controlDone, calibrationDone, setOptions: open => setOptionsOpen(open, false),
    diagnostics: () => ({ vocalMode: isVocalDocument(), events: state.events.length, cursor: state.eventCursor,
      slots: state.nodes.size, words: state.words.length, running: Boolean(state.raf), documentKey: state.document?.documentKey ?? null }) };
  applyConfig(defaults);
  ipc({ cmd: 'ready', value: performance.now() });
})();
