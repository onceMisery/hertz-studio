// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Navigation and chrome; Stage owns time, SpaceStagePure owns rendering.
(function (global) {
  'use strict';
  var root, initialized = false, page = 'closed', host = null, generation = 0;
  var camera = global.SpaceCamera, returnFocus, background = [], queue = [], panels = [];
  var saveTimer = 0, idleTimer = 0, until = 0, dragging = false, pointer = null, point = null;
  var seeking = false, lockRequest = 0, status = { state: 'idle' }, lyricView;
  var contextRetries = 0, contextRetryAt = 0, contextRetryTimer = 0;
  var performanceHost, lyricPerformance = null, performanceId = '', performanceSignature = '';
  var performances = { classic: 'StanzaClassic', cadenza: 'StanzaCadenza', sonnet: 'StanzaSonnet', tempera: 'StanzaTempera' };
  var paramEvents, playerBridge = {}, playerTimer = 0, immersiveNodes = [], immersiveFocus;
  var shelf = null, shelfShown = false;
  var floatTarget = null;
  var panelPreview = null, nodePreview = null, previewTimer = 0, hud = null, hudRecipe = null, hudUntil = 0, hudTimer = 0;
  var zodiacHud = null, zodiacStarCard = null, zodiacSignIndex = -1;
  var zodiacHover = null, zodiacPinTimer = 0, zodiacPinIndex = -1, zodiacSwapTimer = 0;
  var phoenixHud = null, phoenixHudAt = 0, phoenixPhase = '';
  var CN_HOUSES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  var PHOENIX_PHASES = { flight: '翱翔', swarm: '散羽', gather: '聚焰', egg: '凝卵', rebirth: '涅槃' };
  var clickSerial = 0, lastClickAt = 0, downPoint = null, holdTimer = 0, charging = false;
  var warpTimer = 0, warpHideTimer = 0, warpFrameTimer = 0, warpStarted = 0, warpActive = false, warpReady = false, bootSeq = 0;
  var prefs = { sceneSource: 'coast', sceneStates: {}, lyrics: true, lyricStyle: 'subtitle', cinema: true,
    qualityMode: 'auto', playerAutoHide: true, shelfMode: 'side', freeCam: null, schemaVersion: 3 };
  var labels = { auto: '自动', low: '轻量', medium: '标准', high: '高画质' };
  var zeros = new Float32Array(64), sceneTime = 0, lastPosition = -1, lastTrack, lastSceneCover = '';
  var lyricDocument, lyricKey = '', lyricWindow;
  var onset = global.Onset && global.Onset.create ? global.Onset.create({}) : null;
  var frame = { now: 0, dt: 0, time: 0, position: 0, playing: false, bands: zeros,
    level: 0, onset: 0, reduced: false, lyrics: null, pointer: { x: 0, y: 0, active: false } };
  function $(id) { return document.getElementById(id); }
  function assetUrl(url) { return global.hertzHost ? global.hertzHost.assetUrl(url) : url; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function present() { return global.Stage && Stage.presentation ? Stage.presentation() : {}; }
  function catalog() { return global.SpaceStagePure ? SpaceStagePure.catalog() : []; }
  function def(id) { return catalog().filter(function (d) { return d.id === id; })[0]; }
  function isStage(id) { var scene=def(id);return !!scene&&!isLyric(id)&&['频谱','材质','空间背景'].indexOf(scene.category)<0; }
  function isLyric(id) { var scene=def(id); return !!(scene&&scene.capabilities.ownsLyrics); }
  function performanceKind(id) { var scene = def(id); return scene && scene.capabilities.stanzaRenderer; }
  function reduced() { return !!present().reduced || !!(global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function kick() { if (global.Stage && Stage.kick) Stage.kick(); }
  function control(action, value) {
    var detail = { action: action, value: value };
    document.dispatchEvent(new CustomEvent('stage:control', { detail: detail })); return detail.completion;
  }
  function preferences() {
    if (camera) prefs.freeCam = camera.freeSnapshot();
    return JSON.parse(JSON.stringify(prefs));
  }
  function save() { if (saveTimer) clearTimeout(saveTimer); saveTimer = 0; control('space3d', preferences()); }
  function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(save, 240); }
  function normalize(id, value) {
    try { return SpaceStagePure.normalizeState(id, value || {}); }
    catch (_) { return SpaceStagePure.normalizeState(id, {}); }
  }
  function configure(value) {
    if (!value || typeof value !== 'object' || !global.SpaceStagePure) return;
    var old = prefs.sceneSource, id = value.sceneSource;
    // Only explicitly registered aliases can migrate an old source/subscene pair.
    if (id === 'immersive' || id === 'creative') {
      var field = value.field || value.sceneId || '';
      if (typeof field !== 'string') field = '';
      var qualified = field.indexOf('scene:') === 0 ? 'creative/' + field.slice(6) : id + '/' + field;
      id = SpaceStagePure.resolveId ? SpaceStagePure.resolveId(qualified) : null;
    }
    prefs.lyricStyle = isLyric(value.lyricStyle) ? value.lyricStyle : 'subtitle';
    if(isLyric(id)){prefs.lyricStyle=id;id='coast';}
    prefs.sceneSource = isStage(id) ? id : 'coast'; prefs.sceneStates = {};
    if (value.sceneStates && typeof value.sceneStates === 'object') catalog().forEach(function (d) {
      if (Object.prototype.hasOwnProperty.call(value.sceneStates,d.id)) prefs.sceneStates[d.id] = normalize(d.id,value.sceneStates[d.id]);
    });
    if (!prefs.sceneStates.coast && typeof value.coastTod === 'number') prefs.sceneStates.coast = normalize('coast',{params:{tod:value.coastTod}});
    if (typeof value.lyrics === 'boolean') prefs.lyrics = value.lyrics;
    if (typeof value.cinema === 'boolean') prefs.cinema = value.cinema;
    if (typeof value.playerAutoHide === 'boolean') prefs.playerAutoHide = value.playerAutoHide;
    prefs.shelfMode = ['side','stage','off'].indexOf(value.shelfMode) >= 0 ? value.shelfMode : 'side';
    if (shelf) shelf.setMode(prefs.shelfMode);
    prefs.qualityMode = labels[value.qualityMode] ? value.qualityMode : 'auto';
    if (camera && value.freeCam) camera.freeLoad(value.freeCam);
    if (camera) camera.setCinema(prefs.cinema,1);
    if (initialized) {
      syncSettings(); buildCatalog();
      if (page !== 'closed') {
        if (old !== prefs.sceneSource) selectScene(prefs.sceneSource);
        else if (host) { host.setQualityMode(prefs.qualityMode); host.setParams(normalize(prefs.sceneSource,prefs.sceneStates[prefs.sceneSource]).params); buildParams(); touch(); }
        syncLyrics();
      }
    }
    if (JSON.stringify(value) !== JSON.stringify(preferences())) scheduleSave();
  }
  function typing(t) { return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))); }
  function isControl(t) { return t && t.closest && t.closest('button,a,input,select,textarea,[contenteditable],.s3d-sc,.sp-head,.sp-bar,.sp-popover,.sp-fx,.sp-sheet,.sp-playlist,.sh-header,.sh-panel-layer,#qr-modal,#sp-home,#sp-reading,#sp-stanza,#sp-failure'); }
  function loginOpen() { return global.OnlineLogin && OnlineLogin.isOpen && OnlineLogin.isOpen(); }
  function shelfVisible() {
    return page === 'stage' && status.state === 'ready' && !root.classList.contains('sp-immersive') && !loginOpen() &&
      !(root.clientWidth <= 760 && (panels.length || (global.SpaceHome && SpaceHome.isPanelOpen())));
  }
  function syncShelf() {
    if (!shelf) return;
    var visible = shelfVisible() && prefs.shelfMode !== 'off';
    if (visible !== shelfShown) { shelfShown = visible; if (visible) shelf.show(); else shelf.hide(); }
    shelf.setBlocked(!!panels.length || !!loginOpen() || !!(global.SpaceHome && SpaceHome.isPanelOpen()));
  }
  function previewCapable() { var scene = def(prefs.sceneSource), state = prefs.sceneStates[prefs.sceneSource], params = state && state.params || {}; return page === 'stage' && status.state === 'ready' && !!scene && !!scene.capabilities.queuePreview && params.queuePreview !== false && params.trackRecipes !== false; }
  function activePreview() { return previewCapable() ? panelPreview || nodePreview : null; }
  function trackById(id) { return id ? queue.find(function (t) { return t.id === id; }) || null : null; }
  // Sweeping across rows should not re-stage every scene it passes over.
  function setPanelPreview(track) {
    clearTimeout(previewTimer); previewTimer = 0;
    if (!track || !previewCapable()) { panelPreview = null; syncHud(); if(page!=='closed')touch(1800); return; }
    previewTimer = setTimeout(function () { previewTimer = 0; panelPreview = previewCapable() ? trackById(track.id) : null; syncHud(); if(page!=='closed')touch(1800); }, 120);
  }
  function clearPreview() { clearTimeout(previewTimer); previewTimer = 0; panelPreview = null; nodePreview = null; syncHud(); }
  function syncHud() {
    if (!hud) return;
    var preview = activePreview(), presentation = present(), current = presentation.track,
      same = !!(preview && current && preview.id === current.id),
      recent = previewCapable() && hudRecipe && performance.now() < hudUntil, mode = '';
    if (preview && same) {
      mode = 'current'; hud.querySelector('.sp-scene-hud-tag').textContent = presentation.playing ? '正在播放' : '当前曲目';
      hud.querySelector('strong').textContent = preview.title || current.title || '未知曲目';
      hud.querySelector('small').textContent = preview.artist || current.artist || '';
    } else if (preview) {
      mode = 'preview'; hud.querySelector('.sp-scene-hud-tag').textContent = '预览';
      hud.querySelector('strong').textContent = preview.title || '未知曲目';
      hud.querySelector('small').textContent = (preview.artist ? preview.artist + ' · ' : '') + '点击播放';
    } else if (charging && previewCapable()) {
      mode = 'charge'; hud.querySelector('.sp-scene-hud-tag').textContent = '充能';
      hud.querySelector('strong').textContent = '场能过载'; hud.querySelector('small').textContent = '松开稳定';
    } else if (recent) {
      mode = 'recipe'; hud.querySelector('.sp-scene-hud-tag').textContent = '换场';
      hud.querySelector('strong').textContent = hudRecipe.shell + '壳层 · ' + hudRecipe.shot + '机位';
      hud.querySelector('small').textContent = '色相 ' + hudRecipe.hue + '°';
    }
    hud.dataset.mode = mode; hud.hidden = !mode;
  }
  function onRecipe(info) {
    if (hud) hud.style.setProperty('--sp-hud-hue', 'hsl(' + info.hue + ' 85% 64%)');
    if (info.preview) { syncHud(); return; }
    hudRecipe = info; hudUntil = performance.now() + 2600; clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { hudTimer = 0; syncHud(); }, 2700);
    syncHud(); touch(1800);
  }
  function pad2(value) { return (value < 10 ? '0' : '') + value; }
  function zodiacMetaText(info) {
    return '黄道第' + (CN_HOUSES[info.signIndex] || (info.signIndex + 1)) + '宫 · 主星 '
      + info.constellationNodes + ' · 星线 ' + info.constellationSegments;
  }
  function paintZodiacInfo(info) {
    if (!info) return;
    var index = Number(info.signIndex) || 0;
    var plate = pad2(index + 1) + ' — XII';
    var meta = zodiacMetaText(info);
    if ($('sp-zodiac-index')) $('sp-zodiac-index').textContent = plate;
    if ($('sp-zodiac-name')) $('sp-zodiac-name').textContent = info.signCn || '';
    if ($('sp-zodiac-latin')) $('sp-zodiac-latin').textContent = String(info.signEn || '').toUpperCase();
    if ($('sp-zodiac-meta')) $('sp-zodiac-meta').textContent = meta;
    if (zodiacHud) zodiacHud.setAttribute('aria-label', '星座观测：' + (info.signCn || '') + '，第' + (index + 1) + '宫');
    var ticks = $('sp-zodiac-ticks');
    if (ticks) Array.prototype.forEach.call(ticks.children, function (tick, i) { tick.classList.toggle('is-on', i === index); });
    if ($('sp-zodiac-console-index')) $('sp-zodiac-console-index').textContent = plate;
    if ($('sp-zodiac-console-name')) $('sp-zodiac-console-name').textContent = info.signCn || '';
    if ($('sp-zodiac-console-meta')) $('sp-zodiac-console-meta').textContent = meta + ' · 13s 生命周期';
  }
  function setZodiacInfo(info, animate) {
    if (!info || info.signIndex == null) return;
    var changed = info.signIndex !== zodiacSignIndex;
    if (!changed) return;
    zodiacSignIndex = info.signIndex;
    hideZodiacStar(true);
    if (!animate || !zodiacHud || zodiacHud.hidden) { paintZodiacInfo(info); return; }
    if (zodiacSwapTimer) clearTimeout(zodiacSwapTimer);
    zodiacHud.classList.add('is-changing');
    zodiacSwapTimer = setTimeout(function () {
      zodiacSwapTimer = 0;
      paintZodiacInfo(info);
      requestAnimationFrame(function () { if (zodiacHud) zodiacHud.classList.remove('is-changing'); });
    }, 150);
  }
  function scenePrimary() {
    if (!host) return null;
    var measured = host.stats();
    return measured && measured.sceneStats && measured.sceneStats.primary || null;
  }
  function zodiacPrimary() { return scenePrimary(); }
  function zodiacActive() {
    return page === 'stage' && prefs.sceneSource === 'zodiac' && status.state === 'ready'
      && !root.classList.contains('sp-immersive');
  }
  function syncZodiacHud() {
    if (!zodiacHud) return;
    var consoleBlock = $('sp-zodiac-console');
    if (consoleBlock) consoleBlock.hidden = prefs.sceneSource !== 'zodiac';
    var info = zodiacActive() ? zodiacPrimary() : null;
    zodiacHud.hidden = !info;
    if (!info) { hideZodiacStar(true); return; }
    setZodiacInfo(info, zodiacSignIndex >= 0);
    var hint = zodiacHud.querySelector('.sp-zodiac-hint');
    var hintText = info.charge >= .98 ? '蓄能完成 · 松开释放星链脉冲'
      : info.charge > .08 ? '正在蓄能 · 保持按住，松开释放'
      : info.hover >= 0 ? '主星已锁定 · 点击读取 · 按住蓄能'
      : '移动扫描 · 按住蓄能 · 拖拽环绕 · 滚轮缩放';
    if (hint && hint.textContent !== hintText) hint.textContent = hintText;
    if (zodiacHover && zodiacStarCard && !zodiacStarCard.hidden) positionZodiacStar(zodiacHover.x, zodiacHover.y);
  }
  function phoenixActive() {
    return page === 'stage' && prefs.sceneSource === 'phoenix-vortex' && status.state === 'ready'
      && !root.classList.contains('sp-immersive');
  }
  function syncPhoenixHud() {
    if (!phoenixHud) return;
    var info = phoenixActive() ? scenePrimary() : null;
    phoenixHud.hidden = !info;
    if (!info) { phoenixPhase = ''; return; }
    var phase = PHOENIX_PHASES[info.phase] ? info.phase : 'flight';
    var label = PHOENIX_PHASES[phase];
    var charge = clamp(Number(info.charge) || 0, 0, 1);
    var strikes = clamp(Math.round(Number(info.strikes) || 0), 0, 3);
    if (phase !== phoenixPhase) { phoenixPhase = phase; phoenixHud.dataset.phase = phase; }
    var phaseNode = $('sp-phoenix-phase');
    if (phaseNode && phaseNode.textContent !== label) phaseNode.textContent = label;
    var meta, hint;
    if (phase === 'egg') {
      meta = strikes >= 2 ? '蛋壳将裂 · 最后一击'
        : strikes > 0 ? '裂纹蔓延 · 再击 ' + (3 - strikes) + ' 次'
        : charge > .5 ? '烈焰灌入 · 蛋壳嗡鸣' : '蛋壳封火 · 等待唤醒';
      hint = charge > .95 ? '蓄火完成 · 松手裂壳'
        : charge > .08 ? '蓄火中 · 松手裂壳' : '按住蓄火 · 点击裂壳';
    } else if (phase === 'gather') {
      meta = '万羽归焰 · 凝卵成形';
      hint = '点击催火 · 加速凝卵';
    } else if (phase === 'rebirth') {
      meta = '烈焰焚壳 · 涅槃重生';
      hint = '守候余烬 · 等待重生';
    } else if (phase === 'swarm') {
      meta = '凤羽漫天 · 聚散成焰';
      hint = '点击凤凰 · 唤来涅槃';
    } else {
      meta = '烈焰加身 · 长空翱翔';
      hint = '点击凤凰 · 唤来涅槃';
    }
    var metaNode = $('sp-phoenix-meta');
    if (metaNode && metaNode.textContent !== meta) metaNode.textContent = meta;
    var hintNode = $('sp-phoenix-hint');
    if (hintNode && hintNode.textContent !== hint) hintNode.textContent = hint;
    var fill = $('sp-phoenix-charge-fill');
    if (fill) fill.style.width = Math.round(charge * 100) + '%';
    var pips = $('sp-phoenix-pips');
    if (pips) Array.prototype.forEach.call(pips.children, function (pip, i) { pip.classList.toggle('is-on', i < strikes); });
    var aria = '凤凰涅槃：' + label + (phase === 'egg' ? '，裂纹 ' + strikes + ' / 3，蓄火 ' + Math.round(charge * 100) + '%' : '');
    if (phoenixHud.getAttribute('aria-label') !== aria) phoenixHud.setAttribute('aria-label', aria);
  }
  function positionZodiacStar(x, y) {
    if (!zodiacStarCard || !root) return;
    zodiacStarCard.hidden = false;
    var width = root.clientWidth, height = root.clientHeight;
    var cardW = zodiacStarCard.offsetWidth || 148, cardH = zodiacStarCard.offsetHeight || 62;
    var flipped = x + cardW + 36 > width;
    var left = flipped ? x - cardW - 18 : x + 18;
    var top = clamp(y - cardH / 2, 88, Math.max(88, height - cardH - 96));
    zodiacStarCard.style.left = clamp(left, 14, Math.max(14, width - cardW - 14)) + 'px';
    zodiacStarCard.style.top = top + 'px';
    zodiacStarCard.classList.toggle('is-left', flipped);
  }
  function showZodiacStar(event, pinned) {
    if (!zodiacStarCard || !event || event.index == null) return;
    zodiacHover = event;
    var name = '主星 ' + pad2(event.index + 1);
    var meta = '亮度 ' + Number(event.magnitude || 0).toFixed(2) + ' · 连线 ' + (event.links || 0);
    if ($('sp-zodiac-star-name')) $('sp-zodiac-star-name').textContent = name;
    if ($('sp-zodiac-star-meta')) $('sp-zodiac-star-meta').textContent = meta;
    zodiacStarCard.classList.toggle('is-pinned', !!pinned);
    positionZodiacStar(event.x, event.y);
  }
  function hideZodiacStar(force) {
    if (!zodiacStarCard) return;
    if (!force && zodiacPinTimer) return;
    if (zodiacPinTimer) { clearTimeout(zodiacPinTimer); zodiacPinTimer = 0; }
    zodiacPinIndex = -1;
    zodiacHover = null;
    zodiacStarCard.hidden = true;
    zodiacStarCard.classList.remove('is-pinned');
  }
  function onZodiacEvent(event) {
    if (!event || prefs.sceneSource !== 'zodiac' || page !== 'stage') return;
    if (event.type === 'sign') { syncZodiacHud(); return; }
    if (event.type === 'hover') {
      if (!event.hovered) { if (!zodiacPinTimer) hideZodiacStar(); return; }
      if (zodiacPinTimer) {
        if (zodiacPinIndex !== event.index) return;
        zodiacHover = event;
        positionZodiacStar(event.x, event.y);
        return;
      }
      showZodiacStar(event, false);
      return;
    }
    if (event.type === 'select' && event.index != null) {
      zodiacPinIndex = event.index;
      if (zodiacPinTimer) clearTimeout(zodiacPinTimer);
      zodiacPinTimer = setTimeout(function () {
        zodiacPinTimer = 0; zodiacPinIndex = -1; hideZodiacStar(true);
      }, 2600);
      showZodiacStar(event, true);
    }
  }
  function hidePlayer(force) {
    if (page === 'closed' || (!force && (panels.length || loginOpen() || seeking || (global.SpaceHome && SpaceHome.isPanelOpen()) || $('sp-bar').matches(':hover') || $('sp-bar').contains(document.activeElement)))) return;
    root.classList.add('sp-player-hidden'); $('sp-bar').inert = true;
  }
  function schedulePlayerHide(delay) {
    clearTimeout(playerTimer); playerTimer = 0;
    if (prefs.playerAutoHide && page !== 'closed') playerTimer = setTimeout(hidePlayer, delay || 1800);
  }
  function revealPlayer() {
    if(root.classList.contains('sp-immersive'))return;
    root.classList.remove('sp-player-hidden'); $('sp-bar').inert = false; schedulePlayerHide(2600);
  }
  function immersive(value) {
    var on = value == null ? !root.classList.contains('sp-immersive') : value;
    if(on===root.classList.contains('sp-immersive'))return;
    if(on){
      immersiveFocus=document.activeElement;closePanels();if(global.SpaceHome)SpaceHome.closePanel({restoreFocus:false});
      clearTimeout(playerTimer);releaseInput();root.focus({preventScroll:true});
      immersiveNodes=Array.from(root.children).filter(function(node){return !node.matches('.sp-bg,.sp-canvas,.sp-vignette');}).map(function(node){var state={node:node,inert:node.inert};node.inert=true;return state;});
    }else{
      immersiveNodes.forEach(function(item){item.node.inert=item.inert;});immersiveNodes=[];
    }
    root.classList.toggle('sp-immersive',on);
    syncShelf(); syncZodiacHud(); syncPhoenixHud();
    ['sp-immersive','sp-stage-immersive'].forEach(function(id){$(id).setAttribute('aria-pressed',String(on));});
    $('sp-immersive-toggle').checked=on;
    if(!on){
      revealPlayer();var target=immersiveFocus;
      if(!target||!target.isConnected||target.closest('[inert]')||!target.checkVisibility())target=page==='stage'?$('sp-stage-immersive'):$('sp-more');
      target.focus({preventScroll:true});immersiveFocus=null;
    }
    poke();
  }
  function touch(ms) { until = Math.max(until,performance.now()+(ms||900)); kick(); poke(); }
  function homeIdle(value) {
    if (!root || root.classList.contains('sp-home-idle') === value) return;
    root.classList.toggle('sp-home-idle', value);
    $('sp-home').inert = value;
  }
  function hideHome() {
    if (page !== 'home' || panels.length || loginOpen()
      || (global.SpaceHome && SpaceHome.isPanelOpen())
      || !global.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var focused = document.activeElement;
    if ($('sp-home').contains(focused) && focused.matches(':focus-visible')) return;
    homeIdle(true);
  }
  function poke() {
    if (!root) return; root.classList.remove('sp-idle');
    homeIdle(false);
    if (idleTimer) clearTimeout(idleTimer); idleTimer = 0;
    if (page === 'home') idleTimer = setTimeout(function () {
      idleTimer = 0; hideHome();
    },3000);
    else if (page === 'stage') idleTimer = setTimeout(function () {
      idleTimer = 0;
      if (page === 'stage' && present().playing && !panels.length && !isControl(document.activeElement)) root.classList.add('sp-idle');
    },2600);
  }
  function panel(id, open, opener) {
    var node = $(id), index = panels.findIndex(function (p) { return p.id === id; });
    if (open == null) open = index < 0;
    var previous = index >= 0 ? panels[index] : null;
    if (index >= 0) panels.splice(index,1);
    if (open) {
      closePanels();
      if (global.SpaceHome) SpaceHome.closePanel({restoreFocus:false});
      revealPlayer();
    }
    node.classList.toggle('sp-show',!!open); node.inert = !open;
    if (id === 'sp-playlist' && !open) { clearTimeout(previewTimer); previewTimer = 0; panelPreview = null; syncHud(); touch(1800); }
    var trigger = opener || (previous && previous.opener);
    if (trigger) trigger.setAttribute('aria-expanded',String(!!open));
    if(id==='sp-sheet')$('sp-console-toggle').setAttribute('aria-expanded',String(!!open));
    if (open) {
      panels.push({id:id,opener:opener||document.activeElement});
      if (id === 'sp-playlist') buildQueue();
      var first = node.querySelector('button,input,select'); if (first) first.focus({preventScroll:true});
    } else {
      if (opener && opener.isConnected) {
        var target = opener.closest('[inert]') ? $('sp-more') : opener;
        target.focus({preventScroll:true});
      }
      schedulePlayerHide(1000);
    }
    syncShelf(); poke();
  }
  function closePanels() {
    while (panels.length) panel(panels[panels.length-1].id,false);
  }
  function dismissOutside(event) {
    if (page === 'closed' || loginOpen()) return;
    panels.slice().forEach(function (item) {
      if (!$(item.id).contains(event.target) && !(item.opener && item.opener.contains(event.target))) panel(item.id,false);
    });
    if (global.SpaceHome && !event.target.closest('.sh-panel,.sh-header')) SpaceHome.closePanel({restoreFocus:false});
  }
  function clickFeedback(event) {
    if (page === 'closed' || event.button !== 0 || reduced() || document.pointerLockElement || event.target.closest('[data-click-feedback="custom"]')) return;
    var layer = $('sp-click-feedback'), rect = root.getBoundingClientRect(), ring = document.createElement('i');
    ring.className = 'sp-click-ring'; ring.style.left = (event.clientX-rect.left)+'px'; ring.style.top = (event.clientY-rect.top)+'px';
    while (layer.children.length >= 6) layer.firstElementChild.remove();
    layer.appendChild(ring); ring.addEventListener('animationend',function(){ring.remove();},{once:true});
  }
  function favoriteBurst(button){
    if(reduced()||document.hidden)return;
    var layer=$('sp-click-feedback'),rect=button.getBoundingClientRect(),surface=root.getBoundingClientRect();
    var burst=document.createElement('span');burst.className='sp-favorite-burst';
    burst.style.left=(rect.left+rect.width/2-surface.left)+'px';burst.style.top=(rect.top+rect.height/2-surface.top)+'px';
    for(var i=0;i<12;i++){
      var star=document.createElement('i'),angle=(i/12)*Math.PI*2,distance=25+(i%3)*9;
      star.style.setProperty('--star-x',(Math.cos(angle)*distance).toFixed(1)+'px');
      star.style.setProperty('--star-y',(Math.sin(angle)*distance-8).toFixed(1)+'px');
      star.style.setProperty('--star-turn',(i%2?75:-55)+'deg');burst.appendChild(star);
    }
    while(layer.children.length>=6)layer.firstElementChild.remove();
    layer.appendChild(burst);button.classList.remove('sp-favorite-pop');
    button.classList.add('sp-favorite-pop');
    setTimeout(function(){burst.remove();button.classList.remove('sp-favorite-pop');},720);
  }
  function toggleFavorite(){
    if(!playerBridge.favorite||$('sp-favorite').disabled)return;
    var current=present().track,id=current&&current.id,wasOn=$('sp-favorite').getAttribute('aria-pressed')==='true';
    var result=playerBridge.favorite();syncPlayer();
    Promise.resolve(result).then(function(){
      syncPlayer();
      if(page!=='closed'&&present().track&&present().track.id===id&&!wasOn&&$('sp-favorite').getAttribute('aria-pressed')==='true')favoriteBurst($('sp-favorite'));
    }).catch(function(){syncPlayer();});
  }
  function escape() {
    if (loginOpen()) { OnlineLogin.close(); return; }
    if (panels.length) { var p = panels[panels.length-1]; panel(p.id,false,p.opener); return; }
    if (global.SpaceHome && SpaceHome.closePanel()) return;
    if (root.classList.contains('sp-immersive')) { immersive(false); return; }
    if (page === 'stage') goHome(); else close();
  }
  function setPage(next) {
    page = next; root.dataset.page = next; root.classList.remove('sp-idle'); clearPreview();
    poke();
    $('sp-home').hidden = next !== 'home'; $('sp-canvas').hidden = next === 'closed';
    $('sp-stage-settings').hidden = next === 'closed'; $('sp-fx-toggle').hidden = next === 'closed';
    resetFloat();
    var toggle=$('sp-page-toggle'),destination=next==='stage'?'首页':'三维舞台';
    toggle.title=destination;toggle.setAttribute('aria-label',destination);
    toggle.querySelector('use').setAttribute('href',next==='stage'?'#i-home':'#i-cube');
    $('sp-reading').hidden = next !== 'stage'; syncSettings(); syncPlayer(); syncShelf(); syncZodiacHud(); syncPhoenixHud();
  }
  function releaseInput() {
    lockRequest++;
    if (document.pointerLockElement === root && document.exitPointerLock) document.exitPointerLock();
    if (pointer != null && root.hasPointerCapture && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
    dragging = false; pointer = null; point = null; frame.pointer.active = false;
    frame.pointer.down = false; frame.pointer.dragging = false; downPoint = null; clearTimeout(holdTimer); holdTimer = 0;
    if (charging) { charging = false; syncHud(); }
    if (camera) { camera.clearInput(); camera.setRotating(false); if (camera.isFreeActive()) camera.freeToggle(); }
    root.classList.remove('sp-dragging');
  }
  function disposeStage() {
    generation++; releaseInput(); if (host) { host.dispose(); host = null; }
    releasePerformance();
    $('sp-canvas').textContent = ''; status = {state:'idle'}; $('sp-failure').hidden = true;
    if (lyricView) lyricView.reset(); lyricKey = ''; lastPosition = -1; lastTrack = null;
  }
  function buildWarpSpace() {
    var gates = $('sp-warp-gates'), stars = $('sp-warp-stars');
    if (gates && !gates.childElementCount) {
      for (var i = 0; i < 12; i++) {
        var gate = document.createElement('i'); gate.className = 'sp-warp-gate'; gate.style.setProperty('--i', i); gates.appendChild(gate);
      }
    }
    if (stars && !stars.childElementCount) {
      for (var j = 0; j < 64; j++) {
        var star = document.createElement('i'); star.className = 'sp-warp-star';
        star.style.setProperty('--a', (j * 137.508).toFixed(2) + 'deg');
        star.style.setProperty('--r', 70 + (j * 71) % 310 + 'px');
        star.style.setProperty('--d', (-(j % 34) * .072).toFixed(2) + 's');
        star.style.setProperty('--travel', (1.9 + (j % 5) * .14).toFixed(2) + 's');
        stars.appendChild(star);
      }
    }
  }
  function startEntryWarp() {
    var el = $('sp-warp');
    clearTimeout(warpTimer); clearTimeout(warpHideTimer); clearTimeout(warpFrameTimer); warpTimer = warpHideTimer = warpFrameTimer = 0;
    if (root) root.classList.remove('sp-warping');
    if (!el || reduced()) {
      warpActive = warpReady = false;
      if (el) { el.hidden = true; el.classList.remove('sp-warp-on', 'sp-warp-out'); }
      return false;
    }
    warpActive = true; warpReady = false; warpStarted = performance.now();
    buildWarpSpace();
    el.hidden = false; el.classList.remove('sp-warp-out'); el.classList.add('sp-warp-on');
    root.classList.add('sp-warping'); root.setAttribute('aria-busy', 'true');
    warpTimer = setTimeout(function () { warpTimer = 0; finishEntryWarp(); }, 6500);
    return true;
  }
  function readyEntryWarp() {
    if (!warpActive || warpReady) return;
    warpReady = true;
    var remaining = Math.max(0, 800 - (performance.now() - warpStarted));
    clearTimeout(warpTimer);
    warpTimer = setTimeout(function () { warpTimer = 0; finishEntryWarp(); }, remaining);
  }
  function waitEntryWarpFrame() {
    if (!warpActive || warpReady) return;
    clearTimeout(warpFrameTimer); warpFrameTimer = 0;
    var check = function () {
      if (!warpActive) return;
      warpFrameTimer = 0;
      if (host && host.stats().frameCount > 0) readyEntryWarp();
      else warpFrameTimer = setTimeout(check, 50);
    };
    check();
  }
  function finishEntryWarp() {
    clearTimeout(warpTimer); clearTimeout(warpHideTimer); clearTimeout(warpFrameTimer); warpTimer = warpHideTimer = warpFrameTimer = 0;
    if (root) { root.classList.remove('sp-warping'); root.removeAttribute('aria-busy'); }
    var el = $('sp-warp'); if (!el) { warpActive = warpReady = false; return; }
    if (!warpActive) { el.hidden = true; return; }
    warpActive = false; warpReady = false;
    el.classList.remove('sp-warp-on'); el.classList.add('sp-warp-out');
    warpHideTimer = setTimeout(function () {
      warpHideTimer = 0; el.hidden = true; el.classList.remove('sp-warp-out');
    }, 620);
  }
  function cancelEntryWarp() {
    clearTimeout(warpTimer); clearTimeout(warpHideTimer); clearTimeout(warpFrameTimer); warpTimer = warpHideTimer = warpFrameTimer = 0;
    warpActive = warpReady = false;
    if (root) { root.classList.remove('sp-warping'); root.removeAttribute('aria-busy'); }
    var el = $('sp-warp'); if (el) { el.hidden = true; el.classList.remove('sp-warp-on', 'sp-warp-out'); }
  }
  function open(source) {
    if (!initialized) init(); if (!root) return false;
    if (page !== 'closed') { goHome(); return true; }
    if (global.Stage3D && Stage3D.isActive && Stage3D.isActive()) Stage3D.close();
    if (global.NowPlaying && NowPlaying.close) NowPlaying.close();
    returnFocus = document.activeElement;
    if (global.SkinSettingsSheet && SkinSettingsSheet.isOpen()) { returnFocus=$('space3d-entry'); SkinSettingsSheet.close({immediate:true,focusTarget:root}); }
    background = [];
    Array.prototype.forEach.call(document.body.children,function (node) {
      if (node === root || /^(SCRIPT|STYLE|SVG)$/.test(node.tagName)) return;
      background.push({node:node,inert:node.inert}); node.inert = true;
    });
    if (isLyric(source)) prefs.lyricStyle=source;else if (isStage(source)) prefs.sceneSource = source;
    document.body.classList.add('space3d-open'); root.classList.add('sp-open'); root.setAttribute('aria-hidden','false');
    var warped = startEntryWarp();
    setPage('home'); root.focus({preventScroll:true});
    var seq = ++bootSeq, booted = false;
    var begin = function () {
      if (booted || seq !== bootSeq || page !== 'home') return;
      booted = true;
      if (global.SpaceHome) SpaceHome.enter();
      ensureStage(prefs.sceneSource);
    };
    if (warped) {
      var afterFrame = function () { setTimeout(begin, 0); };
      if (global.requestAnimationFrame) requestAnimationFrame(afterFrame); else setTimeout(begin, 0);
      setTimeout(begin, 900);
    } else begin();
    revealPlayer(); kick(); return true;
  }
  function goHome() {
    if (page === 'closed') return false;
    closePanels(); immersive(false); setPage('home'); if (global.SpaceHome) SpaceHome.enter();
    $('sp-page-toggle').focus({preventScroll:true}); save(); kick(); return true;
  }
  function close() {
    if (page === 'closed' || !root) return;
    immersive(false);
    if (loginOpen()) OnlineLogin.close();
    save(); closePanels(); disposeStage(); if (global.SpaceHome) SpaceHome.leave(); setPage('closed'); bootSeq++;
    document.body.classList.remove('space3d-open'); cancelEntryWarp(); root.classList.remove('sp-open','sp-idle','sp-immersive','sp-player-hidden'); root.setAttribute('aria-hidden','true');
    clearTimeout(playerTimer); playerTimer = 0; $('sp-click-feedback').replaceChildren();
    if (idleTimer) clearTimeout(idleTimer); idleTimer = 0; if (camera) camera.dispose();
    background.forEach(function (item) { item.node.inert=item.inert; }); background=[];
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({preventScroll:true}); returnFocus=null; kick();
  }
  function showStatus(next) {
    if (page === 'closed') return;
    var failed = next.state === 'error' || next.state === 'failed' || !!next.error;
    var errorText = String(next.error && next.error.message || next.error || '');
    var contextLost = failed && /webgl context lost/i.test(errorText);
    if (failed) { immersive(false);if(host)disposeStage(); }
    status = next;
    $('sp-failure').hidden = !failed;
    $('sp-error-message').textContent = failed ? (errorText || '场景加载失败') : '';
    $('sp-loading').hidden = next.state !== 'loading'; root.dataset.sceneState=next.state||'idle'; syncSettings(); syncShelf(); syncHud(); syncZodiacHud(); kick();
    if (failed) finishEntryWarp();
    if (next.state === 'ready') { contextRetries = 0; clearTimeout(contextRetryTimer); contextRetryTimer = 0; waitEntryWarpFrame(); }
    else if (contextLost) {
      // GPU 进程重启会带走 WebGL 上下文；浏览器会重建进程，这里等一拍再重建舞台。
      // 每分钟最多两次，避免驱动持续崩溃时在「重建→再丢」之间空转。
      var now = performance.now();
      if (now - contextRetryAt > 60000) contextRetries = 0;
      if (contextRetries < 2) {
        contextRetries += 1; contextRetryAt = now;
        clearTimeout(contextRetryTimer);
        contextRetryTimer = setTimeout(function () {
          contextRetryTimer = 0;
          if (page === 'closed' || status.state !== 'failed') return;
          var onStage = page === 'stage';
          disposeStage();
          if (onStage) enterStage(prefs.sceneSource); else ensureStage(prefs.sceneSource);
        }, 1500);
      }
    }
  }
  async function enterStage(id) {
    if (page === 'closed') open();
    if(isLyric(id)){prefs.lyricStyle=id;prefs.lyrics=true;syncLyrics();id=prefs.sceneSource;}
    var next = isStage(id||prefs.sceneSource) ? id||prefs.sceneSource : 'coast';
    closePanels(); if (global.SpaceHome) SpaceHome.leave(); setPage('stage'); revealPlayer();
    return ensureStage(next);
  }
  async function ensureStage(next) {
    if (!host) {
      var canvas=document.createElement('canvas'); canvas.setAttribute('aria-label','三维舞台'); $('sp-canvas').appendChild(canvas);
      try {
        host=SpaceStagePure.create(canvas,{qualityMode:prefs.qualityMode,deviceTier:global.Stage&&Stage.tier?Stage.tier():1,onStatus:showStatus,onInvalidate:function(){if(page!=='closed')touch(200);}});
        host.setServices({coverUrl:function(){return present().cover||'';},coverItems:function(){return queue.filter(function(t){return t.cover;});},
          resolveCover:function(url){return global.HertzCovers&&HertzCovers.resolve?HertzCovers.resolve(url):url;},
          queue:function(){return queue;},previewTrack:function(id){nodePreview=trackById(id);syncHud();touch(1800);},
          playTrack:function(id){control('queue-play',id);touch();},onRecipe:onRecipe,zodiacEvent:onZodiacEvent,invalidate:function(){if(page!=='closed')touch(300);}}); resize();
        syncLyrics();
      } catch (error) { disposeStage(); showStatus({state:'error',error:error.message}); return false; }
    }
    if (host && status.state === 'ready' && prefs.sceneSource === next) return true;
    return selectScene(next);
  }
  async function selectScene(id) {
    if(isLyric(id))return selectLyric(id);
    var scene=def(id); if(!isStage(id)) return false; prefs.sceneSource=id;
    if(page==='closed'||!host){syncSettings();scheduleSave();return true;}
    releaseInput(); var token=++generation, current=host; showStatus({state:'loading',id:id}); hudRecipe=null; clearPreview();
    if(camera){var baseline=scene.camera.baseline||scene.camera;camera.setBaseline(Object.assign({},baseline,{look:baseline.lookAt||baseline.look||[0,0,0]}));camera.snap();camera.setCinema(prefs.cinema,1);}
    try {
      var state=await current.select(id,prefs.sceneStates[id]);
      if(token!==generation||host!==current||page==='closed')return false;
      prefs.sceneStates[id]=state; sceneTime=0;
      if(camera&&prefs.freeCam)camera.freeLoad(prefs.freeCam);
      buildParams();buildCatalog();syncSettings();scheduleSave();touch();return true;
    }catch(error){if(token===generation)showStatus({state:'error',id:id,error:error.message});return false;}
  }
  async function syncLyrics(){
    if(!host)return;
    var current=host,id=prefs.lyrics&&isLyric(prefs.lyricStyle)?prefs.lyricStyle:null;
    if (performanceKind(id)) id = null;
    syncPerformance(0);
    try{var state=await current.selectLyrics(id,id?prefs.sceneStates[id]:{});if(host!==current)return;if(state)prefs.sceneStates[id]=state;touch();}
    catch(error){if(host===current)showStatus({state:'error',error:error.message});}
  }
  function selectLyric(id){
    if(id!=='subtitle'&&!isLyric(id))return false;
    prefs.lyricStyle=id;lyricKey='';buildCatalog();buildParams();syncSettings();scheduleSave();syncLyrics();touch();return true;
  }
  function toggleLyrics(value){prefs.lyrics=value==null?!prefs.lyrics:value;lyricKey='';syncSettings();syncLyrics();scheduleSave();touch();}
  function resize(){if(host){host.resize(root.clientWidth,root.clientHeight);if(lyricPerformance)lyricPerformance.resize();touch(200);}}
  function fps(){
    if(page==='closed'||!host||document.hidden||status.state==='failed'||status.state==='error')return 0;
    var p=present(),changed=p.position!==lastPosition||(p.track&&p.track.id)!==lastTrack||(p.cover||'')!==lastSceneCover;
    if (lyricPerformance && lyricPerformance.isReady && !lyricPerformance.isReady()) return 30;
    if(!p.playing||reduced())return changed||dragging||performance.now()<until||(camera&&camera.isResetting())?30:0;
    return host.effectiveQuality()==='low'?30:60;
  }
  function lyrics(p){
    var doc=global.Stage&&Stage.lyrics?Stage.lyrics(p.position):null;
    if(!prefs.lyrics||!doc||!doc.lines||!doc.lines.length)return null;
    var index=Math.max(0,doc.index||0),key=index+':'+doc.lines.length;
    if(doc.lines!==lyricDocument||key!==lyricKey){
      lyricDocument=doc.lines;lyricKey=key;var start=Math.max(0,index-3),end=Math.min(doc.lines.length,index+4),lines=[];
      for(var i=start;i<end;i++){
        var line=doc.lines[i],next=doc.lines[i+1],tokens=Stage.lyricTokens?Stage.lyricTokens(line):[];
        lines.push({text:line.text,start:line.start_ms/1000,end:next?next.start_ms/1000:(p.duration||line.start_ms+6000)/1000,
          tokens:(tokens||[]).map(function(t){return{text:t.text,start:t.start_ms/1000,end:(t.end_ms||t.start_ms+400)/1000};})});
      }lyricWindow={lines:lines,index:index-start,trackIndex:index,progress:0};
    }
    var active=lyricWindow.lines[lyricWindow.index];
    lyricWindow.progress=clamp((p.position/1000-active.start)/Math.max(.1,active.end-active.start),0,1);return lyricWindow;
  }
  function subtitles(p, dt){
    var visible=page==='stage'&&prefs.lyrics&&prefs.lyricStyle==='subtitle';
    $('sp-reading').hidden=!visible;
    if(lyricView){lyricView.configure(visible);if(visible)lyricView.update({position:p.position||0,reduced:reduced(),track:p.track});}
    syncPerformance(dt);
  }
  function releasePerformance() {
    if (lyricPerformance) lyricPerformance.destroy();
    lyricPerformance = null; performanceId = ''; performanceSignature = '';
    if (performanceHost) { performanceHost.hidden = true; delete performanceHost.dataset.renderer; }
  }
  function syncPerformance(dt) {
    if (!performanceHost) return;
    var kind = performanceKind(prefs.lyricStyle);
    var visible = !!host && page === 'stage' && prefs.lyrics && !!kind;
    if (!visible) { releasePerformance(); return; }
    var state = normalize(prefs.lyricStyle, prefs.sceneStates[prefs.lyricStyle]), params = state.params;
    var quiet = reduced() || params.reduced;
    performanceHost.hidden = false;
    performanceHost.classList.toggle('s3d-reduced', !!quiet);
    if (performanceId !== prefs.lyricStyle) {
      releasePerformance(); performanceHost.hidden = false;
      var renderer = global[performances[kind]];
      if (!renderer) throw new Error('歌词渲染器不可用：' + kind);
      lyricPerformance = renderer.init(performanceHost, function (ms) { control('seek', ms); touch(); });
      performanceId = prefs.lyricStyle; performanceHost.dataset.renderer = kind;
    }
    var api = lyricPerformance, reactivity = params.reactivity;
    var theme = kind === 'sonnet' ? StanzaTheme.resolveSonnet(reactivity)
      : kind === 'tempera' ? StanzaTheme.resolveTempera(reactivity) : StanzaTheme.resolve(reactivity);
    var signature = StanzaTheme.signature(theme) + JSON.stringify(params) + quiet + host.effectiveQuality();
    if (signature !== performanceSignature) { performanceSignature = signature; touch(200); }
    api.setTheme(theme); api.setFontScale(params.scale); api.setEco(host.effectiveQuality() === 'low');
    api.setPaused(!present().playing || quiet || document.hidden);
    api.setTuning(kind === 'classic' ? Object.assign({}, params, { spacing: params.wordSpacing }) : params);
    if (api.setMotion) api.setMotion(quiet ? 0 : params.speed);
    if (api.setReactivity) api.setReactivity(reactivity);
    if (api.setBgMode) api.setBgMode('stage');
    if (api.rootEl().hidden) api.setVisible(true);
    performanceHost.style.setProperty('--fl-sonnet-accent', theme.accentColor);
    if (dt != null) api.frame(dt);
  }
  function tick(dt){
    if(page==='closed'||!host||document.hidden)return;
    var p=present();frame.now=performance.now();frame.dt=Math.min(.16,dt/1000);frame.time=(p.position||0)/1000;frame.deviceTier=global.Stage&&Stage.tier?Stage.tier():1;
    frame.position=p.position||0;frame.playing=!!p.playing;frame.reduced=reduced();
    frame.bands=global.Stage&&Stage.spectrum?Stage.spectrum()||zeros:zeros;frame.level=global.Stage&&Stage.energy?Stage.energy():0;
    frame.lyrics=lyrics(p);if(onset&&frame.playing&&!frame.reduced)onset.step(dt,frame.bands,frame.now);frame.onset=onset?onset.pulse||0:0;
    frame.track=p.track?{id:p.track.id,cover:p.cover||''}:null;
    var preview=activePreview();frame.preview=preview?{id:preview.id,cover:preview.cover||'',title:preview.title,artist:preview.artist}:null;
    if(frame.playing&&!frame.reduced)sceneTime+=frame.dt;frame.sceneTime=sceneTime;frame.dynamicDt=frame.playing&&!frame.reduced?frame.dt:0;
    if(camera){camera.tick(dt,{playing:frame.playing&&!frame.reduced,reduced:frame.reduced,audioTime:frame.time,energy:frame.level,low:frame.bands[0]||0});host.setRig(camera.pose());}
    try{host.frame(frame);}catch(error){showStatus({state:'error',error:error.message});}
    if (performance.now() - phoenixHudAt > 90) { phoenixHudAt = performance.now(); syncPhoenixHud(); }
    lastPosition=p.position;lastTrack=p.track&&p.track.id;lastSceneCover=p.cover||'';subtitles(p,dt);
  }
  function time(ms){var s=Math.floor(Math.max(0,Number(ms)||0)/1000);return Math.floor(s/60)+':'+('0'+s%60).slice(-2);}
  function syncPlayer(){
    syncShelf();
    var telemetry=$('sp-reactor-telemetry');
    if(telemetry){
      telemetry.hidden=page!=='stage'||prefs.sceneSource!=='reactor'||status.state!=='ready';
      if(!telemetry.hidden&&host){
        var measured=host.stats(),reactor=measured.sceneStats&&measured.sceneStats.primary;
        if(reactor){
          telemetry.querySelector('[data-reactor-energy]').textContent=(reactor.energy*100).toFixed(1)+'%';
          telemetry.querySelector('[data-reactor-yaw]').textContent=reactor.yaw.toFixed(0)+'°';
          telemetry.querySelector('[data-reactor-zoom]').textContent=reactor.zoom.toFixed(2)+'×';
          telemetry.querySelector('[data-reactor-fps]').textContent=measured.actualFps?measured.actualFps.toFixed(0):'—';
        }
      }
    }
    var p=present(),icon=p.playing?'#i-pause':'#i-play',play=$('sp-play'),seek=$('sp-seek');
    if(play.dataset.icon!==icon){play.dataset.icon=icon;play.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><use href="'+icon+'"/></svg>';}
    play.setAttribute('aria-pressed',String(!!p.playing));play.title=p.playing?'暂停':'播放';play.setAttribute('aria-label',play.title);
    seek.max=Math.max(1,p.duration||0);seek.disabled=!p.track||!p.duration;if(!seeking)seek.value=Math.min(p.duration||0,p.position||0);
    seek.setAttribute('aria-valuetext',time(seek.value));$('sp-time').textContent=time(seek.value)+' / '+time(p.duration);
    $('sp-track-title').textContent=p.track?(p.track.title||'正在播放')+(p.track.artist?' · '+p.track.artist:''):'选择一首歌';
    if(global.Online)Online.syncVipTag($('sp-track-heading'),p.track);
    var cover=$('sp-cover'); if(cover.dataset.url!==(p.cover||'')){cover.dataset.url=p.cover||'';if(global.HertzCovers)HertzCovers.applyImg(cover,p.cover||'');else if(p.cover)cover.src=p.cover;else cover.removeAttribute('src');}
    var favorite=playerBridge.favoriteState?playerBridge.favoriteState():{disabled:true,on:false};
    var favoriteButton=$('sp-favorite');favoriteButton.disabled=favorite.disabled;favoriteButton.setAttribute('aria-pressed',String(!!favorite.on));
    favoriteButton.title=favorite.disabled?'当前歌曲暂不可收藏':favorite.on?'取消收藏':'收藏';favoriteButton.setAttribute('aria-label',favoriteButton.title);
    favoriteButton.querySelector('use').setAttribute('href',favorite.on?'#i-heart':'#i-heart-outline');
    var mode=playerBridge.modeState?playerBridge.modeState():{label:'播放模式',icon:'#i-repeat'};
    $('sp-mode').title=mode.label;$('sp-mode').setAttribute('aria-label',mode.label);$('sp-mode').querySelector('use').setAttribute('href',mode.icon);
    $('sp-mode').querySelector('span').textContent=mode.label;
    $('sp-volume-toggle').setAttribute('aria-label','音量 '+Math.round((p.volume==null?.8:p.volume)*100)+'%');
    $('sp-lyric-button').setAttribute('aria-pressed',String(prefs.lyrics));
    $('sp-autohide').setAttribute('aria-pressed',String(prefs.playerAutoHide));
    if(document.activeElement!==$('sp-volume'))$('sp-volume').value=Math.round((p.volume==null?.8:p.volume)*100);
    if(page==='stage')subtitles(p);
    syncZodiacHud();
    syncPhoenixHud();
  }
  function buildQueue(){
    var body=$('sp-playlist-body');body.textContent='';
    if(!queue.length){var empty=document.createElement('p');empty.className='sp-note';empty.textContent='队列是空的';body.appendChild(empty);return;}
    var current=present().track;
    queue.forEach(function(track){
      var row=document.createElement('div');row.className='sp-queue-row';
      var button=document.createElement('button');button.type='button';button.className='sp-queue-item';button.classList.toggle('is-active',!!current&&current.id===track.id);
      var title=document.createElement('strong'),artist=document.createElement('small');title.textContent=track.title||'未知曲目';artist.textContent=track.artist||'';
      var heading=document.createElement('span');heading.className='sp-queue-title';heading.appendChild(title);
      if(global.Online)Online.syncVipTag(heading,track);
      if(global.Online){
        var source=track.source||(String(track.id).startsWith('online:')?String(track.id).split(':')[1]:'local');
        var origin=Online.badge(source),detail=document.createElement('span');detail.textContent=artist.textContent;
        artist.textContent='';artist.append(origin,detail);
      }
      button.append(heading,artist);button.addEventListener('click',function(){control('queue-play',track.id);});
      var remove=document.createElement('button');remove.type='button';remove.className='sp-head-btn';remove.title='移出队列';remove.setAttribute('aria-label','移出队列：'+title.textContent);
      remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trash"/></svg>';remove.disabled=!!current&&current.id===track.id;
      remove.addEventListener('click',function(){control('queue-remove',track.id);});row.append(button,remove);body.appendChild(row);
      row.addEventListener('pointerenter',function(){setPanelPreview(track);});row.addEventListener('pointerleave',function(){setPanelPreview(null);});
      button.addEventListener('focus',function(){setPanelPreview(track);});button.addEventListener('blur',function(){setPanelPreview(null);});
    });
  }
  function buildCatalog(){
    var grid=$('sp-fx-grid'),select=$('sp-source'),lyricSelect=$('sp-lyric-style');
    var focused=grid.contains(document.activeElement)?document.activeElement.dataset.scene:null;
    grid.textContent='';select.textContent='';lyricSelect.textContent='';
    var subtitle=document.createElement('option');subtitle.value='subtitle';subtitle.textContent='简洁字幕';lyricSelect.appendChild(subtitle);
    catalog().forEach(function(scene){
      var option=document.createElement('option');option.value=scene.id;option.textContent=scene.label;
      if(isLyric(scene.id)){lyricSelect.appendChild(option);return;}
      if(!isStage(scene.id))return;
      select.appendChild(option);
      var button=document.createElement('button');button.type='button';button.className='sp-card';button.dataset.scene=scene.id;
      button.classList.toggle('is-active',prefs.sceneSource===scene.id);button.setAttribute('aria-pressed',String(prefs.sceneSource===scene.id));
      if(scene.preview){var img=document.createElement('img');img.src=assetUrl(scene.preview);img.alt='';img.loading='lazy';button.appendChild(img);}
      var name=document.createElement('strong'),category=document.createElement('small');name.textContent=scene.label;category.textContent=scene.category||'空间场景';button.append(name,category);
      button.addEventListener('click',function(){selectScene(scene.id);});grid.appendChild(button);
    });select.value=prefs.sceneSource;lyricSelect.value=prefs.lyricStyle;
    if(focused){var target=Array.from(grid.children).find(function(button){return button.dataset.scene===focused;});if(target)target.focus({preventScroll:true});}
  }
  function buildParams(){
    // Removing an edited input can synchronously commit its pending change.
    if(paramEvents)paramEvents.abort();paramEvents=new AbortController();
    renderParams(prefs.sceneSource,$('sp-scene-params'),false);
    renderParams(prefs.lyricStyle,$('sp-lyric-params'),true);
  }
  function renderParams(id,container,lyric){
    container.textContent='';container.dataset.scene=id;var scene=def(id);if(!scene)return;
    var state=normalize(scene.id,prefs.sceneStates[scene.id]);prefs.sceneStates[scene.id]=state;
    var specs=Array.isArray(scene.params)?scene.params:Object.keys(scene.params||{}).map(function(key){return Object.assign({key:key},scene.params[key]);});
    var advanced=document.createElement('details'),summary=document.createElement('summary');summary.textContent='光效与质感';advanced.appendChild(summary);
    var advancedBody=document.createElement('div');advancedBody.className='sp-param-body';advanced.appendChild(advancedBody);
    var advancedCount=0;
    var effectKeys=['dust','discRing','ripples','halftone','grain','vignette','softness','bokeh','chroma','aberration','distort','bloom'];
    var lyricKeys=['speed','reduced','textWidth','spacing','arc','karaoke','layout','colorMode','composition','shotFlow','sceneKind'];
    var kind = performanceKind(id);
    if (kind) lyricKeys = ['scale','speed','reactivity','reduced'].concat({
      classic: ['rotation','breathing','wordSpacing'], cadenza: ['width','motion','glow','beam'],
      sonnet: ['shotFlow','lyricLayout','phraseLength','decor','accents','halation','atmosphere'],
      tempera: ['colorMode','composition','screens','inversion','halation','seams']
    }[kind]);
    specs.forEach(function(spec){
      var key=spec.key||spec.id;if(lyric&&lyricKeys.indexOf(key)<0)return;
      var target=!lyric&&effectKeys.indexOf(key)>=0?advancedBody:container;
      var label=document.createElement('label'),input;label.textContent=spec.label||key;label.htmlFor=(lyric?'sp-lyric-param-':'sp-param-')+key;
      if(spec.type==='select'||spec.type==='enum'){
        input=document.createElement('select');(spec.options||[]).forEach(function(choice){var option=document.createElement('option');option.value=Array.isArray(choice)?choice[0]:typeof choice==='object'?choice.value:choice;option.textContent=Array.isArray(choice)?choice[1]:typeof choice==='object'?choice.label:choice;input.appendChild(option);});
      }else{input=document.createElement('input');input.type=spec.type==='boolean'||spec.type==='toggle'?'checkbox':spec.type==='color'?'color':spec.type==='string'?'text':'range';if(input.type==='range'){input.min=spec.min;input.max=spec.max;input.step=spec.step||.01;}if(input.type==='text')input.maxLength=spec.maxLength||256;}
      if (kind && key === 'scale') { input.min = .7; input.max = 1.5; }
      if (kind && key === 'speed') input.max = 1;
      input.id=label.htmlFor;if(input.type==='checkbox')input.checked=!!state.params[key];else input.value=state.params[key];
      var output=document.createElement('output');output.htmlFor=input.id;
      function display(){output.textContent=input.type==='range'?input.value+(spec.unit||''):'';}display();
      input.addEventListener(input.type==='range'?'input':'change',function(){
        var next=Object.assign({},state.params),value=input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value;
        if(input.tagName==='SELECT'){
          var choice=spec.options.find(function(option){return String(typeof option==='object'?option.value:option)===input.value;});
          value=typeof choice==='object'?choice.value:choice;
        }
        next[key]=value;
        try{state=SpaceStagePure.normalizeState(scene.id,{stateVersion:scene.stateVersion,params:next});prefs.sceneStates[scene.id]=state;if(host){if(lyric){if(kind)syncPerformance(0);else host.setLyricParams(state.params);}else host.setParams(state.params);}display();scheduleSave();touch();}
        catch(error){showStatus({state:'error',error:error.message});}
      },{signal:paramEvents.signal});
      var field=document.createElement('div');field.className='sp-param-field'+(input.type==='checkbox'?' is-toggle':'');
      field.append(label,output,input);target.appendChild(field);
      if(target===advancedBody)advancedCount++;
    });
    if(advancedCount)container.appendChild(advanced);
  }
  function consoleTab(name,focus){
    root.querySelectorAll('[data-console-tab]').forEach(function(tab){
      var active=tab.dataset.consoleTab===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
      $(tab.getAttribute('aria-controls')).hidden=!active;if(active&&focus)tab.focus({preventScroll:true});
    });$('sp-sheet').querySelector('.sp-console-scroll').scrollTop=0;
  }
  function syncSettings(){
    if(!initialized)return;$('sp-source').value=prefs.sceneSource;$('sp-quality').value=prefs.qualityMode;
    $('sp-lyrics-toggle').checked=prefs.lyrics;$('sp-cinema-toggle').checked=prefs.cinema;
    $('sp-shelf-mode').value=prefs.shelfMode;
    $('sp-lyric-style').value=prefs.lyricStyle;$('sp-lyric-style').disabled=!prefs.lyrics;$('sp-lyric-params').inert=!prefs.lyrics;
    $('sp-lyric-params').classList.toggle('is-disabled',!prefs.lyrics);
    $('sp-console-toggle').setAttribute('aria-expanded',String(panels.some(function(p){return p.id==='sp-sheet';})));
    $('sp-quality-status').hidden=page==='closed';
    $('sp-quality-status').textContent='当前：'+(labels[status.effectiveQuality]||status.effectiveQuality||'检测中')+(status.qualityReason?' · '+status.qualityReason:'');
    $('sp-loading').hidden=page==='closed'||status.state!=='loading';
  }
  function requestLock(){
    var token=++lockRequest;function denied(){if(token===lockRequest&&camera){camera.clearInput();if(camera.isFreeActive())camera.freeToggle();}}
    if(!root.requestPointerLock){denied();return;}try{Promise.resolve(root.requestPointerLock()).catch(denied);}catch(_){denied();}
  }
  function resetFloat(){
    if(!floatTarget)return;
    floatTarget.style.removeProperty('--sp-tilt-x');floatTarget.style.removeProperty('--sp-tilt-y');floatTarget.style.removeProperty('--sp-glare-x');floatTarget.style.removeProperty('--sp-glare-y');floatTarget=null;
  }
  function floatPointer(e){
    if(page==='closed'||e.pointerType!=='mouse'||reduced()||!matchMedia('(hover:hover) and (pointer:fine)').matches){resetFloat();return;}
    var target=e.target.closest('.sh-action,.sh-next-up,.sp-bar,.sp-nav button');
    if(target!==floatTarget){resetFloat();floatTarget=target;}
    if(!target)return;
    var rect=target.getBoundingClientRect(),card=target.classList.contains('sh-action'),strength=target.classList.contains('sp-bar')?.65:2;
    var px=clamp((e.clientX-rect.left)/rect.width,0,1),py=clamp((e.clientY-rect.top)/rect.height,0,1);
    target.style.setProperty('--sp-tilt-x',((.5-py)*2*(card?9:strength)).toFixed(2)+'deg');
    target.style.setProperty('--sp-tilt-y',((px-.5)*2*(card?11:strength)).toFixed(2)+'deg');
    if(card){target.style.setProperty('--sp-glare-x',(px*100).toFixed(1)+'%');target.style.setProperty('--sp-glare-y',(py*100).toFixed(1)+'%');}
  }
  function bindGestures(){
    root.addEventListener('pointerenter',poke);
    root.addEventListener('pointermove',floatPointer,{passive:true});
    root.addEventListener('pointerleave',resetFloat);
    root.addEventListener('pointerout',function(e){if(floatTarget&&!floatTarget.contains(e.relatedTarget))resetFloat();});
    root.addEventListener('pointerdown',function(e){
      if(page!=='stage'||!camera||isControl(e.target)||e.button!==0)return;
      if(camera.isFreeActive()){requestLock();e.preventDefault();return;}
      dragging=true;pointer=e.pointerId;point={x:e.clientX,y:e.clientY,t:performance.now()};camera.setRotating(true);if(root.setPointerCapture)root.setPointerCapture(pointer);touch();
      downPoint={x:e.clientX,y:e.clientY};frame.pointer.down=true;frame.pointer.dragging=false;clearTimeout(holdTimer);
      frame.pointer.x=e.clientX/Math.max(1,root.clientWidth)*2-1;frame.pointer.y=1-e.clientY/Math.max(1,root.clientHeight)*2;frame.pointer.active=true;
      holdTimer=setTimeout(function(){holdTimer=0;if(frame.pointer.down){charging=true;syncHud();}},350);
    });
    root.addEventListener('pointermove',function(e){
      if(page==='closed')return;poke();var wasActive=frame.pointer.active;frame.pointer.x=e.clientX/Math.max(1,root.clientWidth)*2-1;frame.pointer.y=1-e.clientY/Math.max(1,root.clientHeight)*2;frame.pointer.active=!isControl(e.target);
      if(frame.pointer.active||wasActive)touch(750);
      if (e.clientY > root.clientHeight - 28 && !root.classList.contains('sp-immersive')) revealPlayer();
      if(document.pointerLockElement===root&&camera&&camera.isFreeActive()){camera.freeLook(e.movementX||0,e.movementY||0);touch();return;}
      if(!dragging||e.pointerId!==pointer||!point)return;var now=performance.now();
      if(downPoint&&!frame.pointer.dragging&&Math.hypot(e.clientX-downPoint.x,e.clientY-downPoint.y)>5){frame.pointer.dragging=true;frame.pointer.down=false;clearTimeout(holdTimer);holdTimer=0;if(charging){charging=false;syncHud();}}
      camera.spinDrag(e.clientX-point.x,e.clientY-point.y,clamp((now-point.t)/1000,1/120,.08));point={x:e.clientX,y:e.clientY,t:now};touch();
    });
    root.addEventListener('pointerleave',function(){frame.pointer.active=false;if(page!=='closed'){touch(750);hideHome();}});
    function end(e){
      if(e.pointerId!==pointer)return;
      if(e.type==='pointerup'&&downPoint&&!frame.pointer.dragging){
        // A double-click resets the camera; it must not release a second particle burst.
        var clickAt=performance.now();
        if(clickAt-lastClickAt>250){lastClickAt=clickAt;frame.pointer.click={x:e.clientX/Math.max(1,root.clientWidth)*2-1,y:1-e.clientY/Math.max(1,root.clientHeight)*2,serial:++clickSerial};}
      }
      downPoint=null;frame.pointer.down=false;frame.pointer.dragging=false;clearTimeout(holdTimer);holdTimer=0;if(charging){charging=false;syncHud();}
      dragging=false;point=null;pointer=null;if(camera)camera.setRotating(false);scheduleSave();touch();
    }
    root.addEventListener('pointerup',end);root.addEventListener('pointercancel',end);
    root.addEventListener('wheel',function(e){poke();if(page!=='stage'||!camera||isControl(e.target))return;e.preventDefault();camera.wheel(e.deltaY,{free:camera.isFreeActive()});touch();scheduleSave();},{passive:false});
    root.addEventListener('dblclick',function(e){if(root.classList.contains('sp-immersive')){immersive(false);return;}if(page!=='stage'||!camera||isControl(e.target))return;if(camera.isFreeEngaged())camera.freeReset();else camera.recenter();touch();});
  }
  function bindChrome(){
    function click(id,fn){$(id).addEventListener('click',fn);}
    click('sp-return-2d',close);click('sp-page-toggle',function(){if(page==='stage')goHome();else enterStage();});
    click('sp-stage-jump',function(){if(page==='home')enterStage();else goHome();});
    click('sp-account',function(){closePanels();if(global.SpaceHome)SpaceHome.closePanel({restoreFocus:false});if(global.OnlineLogin)OnlineLogin.open(null,{container:root,presentation:'space'});});
    click('sp-player-handle',revealPlayer);click('sp-collapse',function(){ closePanels(); $('sp-player-handle').focus({preventScroll:true}); hidePlayer(true); });
    click('sp-more',function(){panel('sp-player-options',null,$('sp-more'));});
    click('sp-volume-toggle',function(){panel('sp-volume-panel',null,$('sp-volume-toggle'));});
    click('sp-autohide',function(){prefs.playerAutoHide=!prefs.playerAutoHide;revealPlayer();scheduleSave();syncPlayer();});
    click('sp-immersive',function(){immersive();});
    click('sp-stage-immersive',function(){immersive();});
    click('sp-console-toggle',function(){panel('sp-sheet',null,$('sp-console-toggle'));});
    $('sp-immersive-toggle').addEventListener('change',function(){immersive(this.checked);});
    root.querySelectorAll('[data-console-tab]').forEach(function(tab){
      tab.addEventListener('click',function(){consoleTab(tab.dataset.consoleTab);});
      tab.addEventListener('keydown',function(e){
        var names=['stage','lyrics','camera','display'],index=names.indexOf(tab.dataset.consoleTab),next;
        if(e.key==='ArrowRight')next=(index+1)%names.length;else if(e.key==='ArrowLeft')next=(index+names.length-1)%names.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=names.length-1;else return;
        e.preventDefault();e.stopPropagation();consoleTab(names[next],true);
      });
    });
    click('sp-favorite',toggleFavorite);
    click('sp-mode',function(){if(playerBridge.mode)playerBridge.mode();});
    click('sp-mute',function(){if(playerBridge.mute)playerBridge.mute();});
    click('sp-lyric-button',function(){toggleLyrics();});
    $('sp-bar').addEventListener('pointerenter',function(){clearTimeout(playerTimer);revealPlayer();});
    $('sp-bar').addEventListener('pointerleave',function(){schedulePlayerHide(600);});
    $('sp-bar').addEventListener('focusin',revealPlayer);
    $('sp-bar').addEventListener('focusout',function(){schedulePlayerHide(900);});
    click('sp-prev',function(){control('prev');});click('sp-next',function(){control('next');});click('sp-play',function(){control('toggle');touch();});
    click('sp-fab',function(){panel('sp-sheet',null,$('sp-fab'));});click('sp-sheet-close',function(){var current=panels.find(function(p){return p.id==='sp-sheet';});panel('sp-sheet',false,current&&current.opener||$('sp-fab'));});
    click('sp-playlist-toggle',function(){panel('sp-playlist',null,$('sp-playlist-toggle'));});click('sp-playlist-close',function(){panel('sp-playlist',false,$('sp-playlist-toggle'));});
    click('sp-fx-toggle',function(){consoleTab('stage');panel('sp-sheet',true,$('sp-fx-toggle'));});
    click('sp-retry',function(){disposeStage();enterStage();});click('sp-failure-home',goHome);
    click('sp-reset-camera',function(){if(camera)camera.isFreeEngaged()?camera.freeReset():camera.recenter();touch(1500);});
    click('sp-defaults',function(){prefs.sceneSource='coast';prefs.sceneStates={};prefs.lyrics=true;prefs.lyricStyle='subtitle';prefs.cinema=true;prefs.qualityMode='auto';prefs.playerAutoHide=true;prefs.shelfMode='side';if(shelf)shelf.setMode('side');syncShelf();revealPlayer();if(camera){camera.freeReset();camera.setCinema(true,1);}if(host){host.setQualityMode('auto');selectScene('coast');syncLyrics();}buildCatalog();syncSettings();scheduleSave();});
    $('sp-source').addEventListener('change',function(){selectScene(this.value);});
    $('sp-lyric-style').addEventListener('change',function(){selectLyric(this.value);});
    $('sp-quality').addEventListener('change',function(){prefs.qualityMode=this.value;if(host)host.setQualityMode(this.value);scheduleSave();touch();});
    $('sp-shelf-mode').addEventListener('change',function(){prefs.shelfMode=this.value;if(shelf)shelf.setMode(this.value);syncShelf();scheduleSave();touch();});
    $('sp-lyrics-toggle').addEventListener('change',function(){toggleLyrics(this.checked);});
    $('sp-cinema-toggle').addEventListener('change',function(){prefs.cinema=this.checked;if(camera)camera.setCinema(this.checked,1);scheduleSave();touch();});
    $('sp-seek').addEventListener('input',function(){seeking=true;syncPlayer();});$('sp-seek').addEventListener('change',function(){control('seek',Number(this.value));seeking=false;touch();});$('sp-seek').addEventListener('blur',function(){seeking=false;});
    $('sp-volume').addEventListener('input',function(){control('volume',Number(this.value)/100);});
    ['space3d-entry','set-space3d-btn'].forEach(function(id){if($(id))$(id).addEventListener('click',function(){open();});});
    root.addEventListener('focusin',poke);
    root.addEventListener('focusout',function(){if(!root.classList.contains('sp-home-idle'))poke();});
    root.addEventListener('pointerdown',poke,true);
    root.addEventListener('scroll',poke,true);
    root.addEventListener('pointerdown',dismissOutside,true);
    root.addEventListener('pointerdown',clickFeedback,true);
    document.addEventListener('keydown',function(e){
      if(page==='closed')return;poke();if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();escape();return;}if(loginOpen()||typing(e.target))return;
      if(root.classList.contains('sp-immersive')&&e.code!=='KeyF'&&e.code!=='KeyX'){
        if(e.code==='Slash'||((e.ctrlKey||e.metaKey)&&e.code==='KeyK')||/^Digit[1-9]$/.test(e.code)){e.preventDefault();e.stopImmediatePropagation();}
        return;
      }
      if(e.code==='KeyX'){if(!e.repeat)close();e.preventDefault();e.stopImmediatePropagation();return;}
      if(e.code==='Slash'||((e.ctrlKey||e.metaKey)&&e.code==='KeyK')){closePanels();immersive(false);if(global.SpaceHome)SpaceHome.focusSearch();e.preventDefault();e.stopImmediatePropagation();return;}
      if(/^Digit[1-9]$/.test(e.code)){e.preventDefault();e.stopImmediatePropagation();return;}
      if(page!=='stage')return;
      if(camera&&camera.isFreeActive()&&new RegExp(camera.CONSTANTS.FREE_MOVE_CODES).test(e.code)){camera.freeKey(e.code,true);touch();e.preventDefault();e.stopImmediatePropagation();return;}
      var actions={KeyF:function(){immersive();},KeyQ:function(){panel('sp-playlist',null,$('sp-playlist-toggle'));},KeyK:function(){$('sp-reset-camera').click();},KeyL:function(){toggleLyrics();}};
      if(actions[e.code]){if(!e.repeat)actions[e.code]();e.preventDefault();e.stopImmediatePropagation();}
    },true);
    document.addEventListener('keyup',function(e){if(page==='stage'&&camera)camera.freeKey(e.code,false);});
    function pauseInput(){if(page==='closed')return;releaseInput();hideHome();save();}
    global.addEventListener('blur',pauseInput);global.addEventListener('pagehide',pauseInput);
    document.addEventListener('visibilitychange',function(){if(document.hidden){pauseInput();if(lyricPerformance)lyricPerformance.setPaused(true);}else{touch(300);syncPlayer();}});global.addEventListener('resize',resize);
  }
  function init(){
    if(initialized)return true;root=$('space3d');if(!root)return false;initialized=true;
    if(global.StageShelf){shelf=StageShelf.create(root,{gateId:'space3d-shelf',isVisible:shelfVisible,keyboard:true,onHover:function(id){setPanelPreview(trackById(id));}});if(shelf){shelf.setMode(prefs.shelfMode);shelf.setItems(queue);}}
    if(global.StageLyrics)lyricView=StageLyrics.init($('sp-reading'),function(ms){control('seek',ms);});
    performanceHost = document.createElement('div'); performanceHost.id = 'sp-stanza';
    performanceHost.className = 'fl-root sp-stanza'; performanceHost.hidden = true; root.appendChild(performanceHost);
    if(global.SpaceHome)SpaceHome.init($('sp-home'),{enterStage:enterStage,exitSpace:close,chromeRoot:root,revealPlayer:revealPlayer,beforeOpenPanel:closePanels});
    var feedback=document.createElement('div');feedback.id='sp-click-feedback';feedback.setAttribute('aria-hidden','true');root.appendChild(feedback);
    hud=document.createElement('div');hud.id='sp-scene-hud';hud.className='sp-scene-hud';hud.setAttribute('role','status');hud.setAttribute('aria-live','polite');hud.hidden=true;
    hud.innerHTML='<i aria-hidden="true"></i><span class="sp-scene-hud-tag"></span><strong></strong><small></small>';root.appendChild(hud);
    zodiacHud=$('sp-zodiac-hud'); zodiacStarCard=$('sp-zodiac-star'); phoenixHud=$('sp-phoenix-hud');
    var zodiacTicks=$('sp-zodiac-ticks');
    if(zodiacTicks) for(var zi=0;zi<12;zi++) zodiacTicks.appendChild(document.createElement('i'));
    var telemetry=document.createElement('aside');telemetry.id='sp-reactor-telemetry';telemetry.className='sp-reactor-telemetry';telemetry.hidden=true;
    telemetry.innerHTML='<span class="sp-reactor-label">PARTICLE REACTOR</span><strong>粒子反应堆</strong><dl><div><dt>能量</dt><dd data-reactor-energy>—</dd></div><div><dt>偏航</dt><dd data-reactor-yaw>—</dd></div><div><dt>缩放</dt><dd data-reactor-zoom>—</dd></div><div><dt>FPS</dt><dd data-reactor-fps>—</dd></div></dl><p>拖拽环绕 · 滚轮缩放<br>点击脉冲 · 按住充能<br>悬停队列预览 · 点击切歌</p>';root.appendChild(telemetry);
    bindChrome();bindGestures();buildCatalog();syncSettings();['sp-sheet','sp-playlist','sp-player-options','sp-volume-panel'].forEach(function(id){$(id).inert=true;});
    if(global.Stage&&Stage.gate){Stage.gate('space3d',fps,tick);Stage.gate('space3d-ui',function(){return page!=='closed'&&!document.hidden?4:0;},function(){syncPlayer();if(global.SpaceHome)SpaceHome.update();});}
    root.dataset.spReady='1';return true;
  }
  function rendererStats() {
    if (!host) return null;
    var stats = host.stats();
    stats.lyricBackend = performanceId ? 'stanza' : 'threejs';
    if (performanceId) stats.lyricId = performanceId;
    return stats;
  }
  global.Space3D={init:init,open:open,close:close,toggle:function(id){if(page==='closed')open(id);else close();return page!=='closed';},isActive:function(){return page!=='closed';},
    enterStage:enterStage,goHome:goHome,configure:configure,preferences:preferences,bindPlayer:function(bridge){playerBridge=bridge||{};},openQueue:function(){if(page!=='closed')panel('sp-playlist',true,$('sp-playlist-toggle'));},setQueue:function(list){
      queue=list||[];panelPreview=panelPreview?trackById(panelPreview.id):null;nodePreview=nodePreview?trackById(nodePreview.id):null;
      if(shelf)shelf.setItems(queue);if(panels.some(function(p){return p.id==='sp-playlist';}))buildQueue();
      if(page!=='closed'){syncHud();touch(1800);}
    },
    setSource:selectScene,setLyricStyle:selectLyric,setField:function(id){return selectScene(global.SpaceStagePure&&SpaceStagePure.resolveId?SpaceStagePure.resolveId(id):id);},sourceId:function(){return prefs.sceneSource;},
    stats:function(){return{active:page!=='closed',page:page,source:prefs.sceneSource,renderer:rendererStats(),camera:camera?camera.pose():null,freeCam:camera?camera.isFreeEngaged():false,state:status,panels:panels.map(function(p){return p.id;})};}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
}(window));
