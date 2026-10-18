// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 用户创意工坊：编辑"一份舞台"的那个面板。
//
// 它自己不持有任何渲染知识 —— 这是刻意的。工坊只做三件事：
//   1. 从 CreativeStage.spec() 拿到参数元数据（名字、量程、单位、默认值），
//      按它生成控件。所以"加一个旋钮"= 在 creative-stage.js 的表里加一行，
//      工坊一行都不用改；
//   2. 把用户的编辑变成 setParam / addCue / setBindings 三种调用；
//   3. 把当前预置整体读写成 JSON —— 导出、导入、存进预置库。
//
// 于是"写下来的东西"和"跑起来的东西"永远是同一份数据，不存在"面板显示的
// 和实际渲染的对不上"这类问题：面板读的就是渲染器每帧读的那张表。
//
// 页签对应编辑动作，而不是几种界面：一句成景（生成）+ 场景（选）+ 参数（调）
// + 编排（排）+ 绑定（接）+ 保存（传）。其中"一句成景"只做解释与确认，
// 参数写入全部经由 CreativeStage.applyIntent 这个原子口。

(function () {
  'use strict';

  var tab = 'scene';
  var refs = {};
  var lastParamPath = null;
  var GUIDE_KEY = 'vmusic.workshop.guide.v1';
  var helpSeq = 0;
  var target = 'immersive', returnFocus = null, home = null;
  var past = [], future = [], gesture = null;
  var shareViewRevision = 0, shareEditRevision = 0;
  var resetting = false;
  var renderedPage = null;
  // 「动画绘景」入口暂时下架：四幅画稿的构图与配色还没到能拿出手的程度，先收起用户
  // 可见的两处入口——这里的画册，以及 index.html「舞台来源」下拉里那个 option。
  // 画稿资产、注册表、SVG 适配层与 CSS 一律原样保留，已经停在该来源的舞台不受影响；
  // 恢复时把开关改回 true，并删掉那个 option 上的 hidden。
  var showAnimeScenery = false;
  var artObserver = null, artPreviews = [], artPaused = false, artRate = 1;

  // Navigation illustrations use CSS, independently of audio playback. This
  // owner only gates visibility; it never creates a second stage/frame loop.
  function syncSceneArt() {
    var active = isOpen() && target === 'advanced' && tab === 'scene' && !document.hidden && !artPaused;
    artPreviews.forEach(function (preview) {
      preview.dataset.motion = active && preview.dataset.inView === 'true' ? 'running' : 'paused';
      preview.getAnimations({ subtree: true }).forEach(function (animation) {
        if (animation.effect.getTiming().iterations === Infinity && animation.playbackRate !== artRate) {
          animation.updatePlaybackRate(artRate);
        }
      });
    });
  }

  function updateArtControls() {
    var motion = refs.body.querySelector('.ws-anime-motion-toggle');
    var speed = refs.body.querySelector('.ws-anime-speed');
    if (motion) {
      motion.textContent = artPaused ? '继续动画' : '暂停动画';
      motion.setAttribute('aria-pressed', String(artPaused));
    }
    if (speed) speed.textContent = artRate + '×';
    syncSceneArt();
  }

  function sceneArtKey(event) {
    if (!event.target.closest('.ws-anime-gallery') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space' && event.target.classList.contains('ws-anime-gallery')) artPaused = !artPaused;
    else if (event.key === 'ArrowRight') artRate = Math.min(1.5, artRate + .25);
    else if (event.key === 'ArrowLeft') artRate = Math.max(.5, artRate - .25);
    else return;
    event.preventDefault();
    updateArtControls();
  }

  function releaseSceneArt() {
    if (artObserver) artObserver.disconnect();
    artObserver = null;
    artPreviews.forEach(function (preview) { preview.dataset.motion = 'paused'; });
    artPreviews = [];
  }

  function observeSceneArt() {
    if (!isOpen() || target !== 'advanced' || tab !== 'scene') return;
    artPreviews = Array.from(refs.body.querySelectorAll('.ws-anime-preview'));
    if (!artPreviews.length) return;
    artObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.target.isConnected) entry.target.dataset.inView = String(entry.isIntersecting && entry.intersectionRatio > 0);
      });
      syncSceneArt();
    }, { root: refs.body, threshold: 0 });
    artPreviews.forEach(function (preview) { artObserver.observe(preview); });
  }

  function $(id) { return document.getElementById(id); }

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function stage_api() { return window.CreativeStage; }

  function guideDismissed() {
    try { return localStorage.getItem(GUIDE_KEY) === '1'; }
    catch (e) { return false; }
  }

  function dismissGuide() {
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function guideCard() {
    if (guideDismissed()) return null;
    var card = h('div', 'ws-guide');
    card.appendChild(h('div', 'ws-guide-title', '四步上手'));
    var list = h('ol', 'ws-guide-list');
    [
      '在下方选择一个三维场景',
      '到「参数」里调镜头、影调和场景细节',
      '到「编排」里按歌曲时间或鼓点添加触发',
      '满意后点「存进工坊」，或到「导出」分享 JSON'
    ].forEach(function (text) { list.appendChild(h('li', null, text)); });
    card.appendChild(list);

    var actions = h('div', 'ws-guide-actions');
    var start = h('button', 'btn primary', '去调参数');
    start.type = 'button';
    start.addEventListener('click', function () {
      dismissGuide();
      tab = 'params';
      render();
    });
    var ok = h('button', 'btn', '知道了');
    ok.type = 'button';
    ok.addEventListener('click', function () {
      dismissGuide();
      card.remove();
    });
    actions.append(start, ok);
    card.appendChild(actions);
    return card;
  }

  function help(text) {
    helpSeq += 1;
    var wrap = h('span', 'ws-help');
    var btn = h('button', 'ws-help-btn', '?');
    var tip = h('span', 'ws-tip', text);
    var tipId = 'ws-tip-' + helpSeq;
    btn.type = 'button';
    btn.setAttribute('aria-label', '查看说明');
    btn.setAttribute('aria-describedby', tipId);
    tip.id = tipId;
    wrap.append(btn, tip);
    return wrap;
  }

  function num(v, digits) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return digits === undefined ? String(n) : n.toFixed(digits);
  }

  // -------------------------------------------------------------------------
  // 复用控件
  // -------------------------------------------------------------------------

  /**
   * 旋钮。row = [路径, 名称, min, max, step, 单位, 默认值]。
   * onChange 每次 input 都回调（实时生效），所以拖动过程中画面就是跟着走的。
   */
  function slider(row, value, onChange) {
    var path = row[0];
    var cell = h('div', 'sc-cell');
    var label = h('label', 'sc-label');
    label.setAttribute('for', 'ws-' + path.replace('.', '-'));
    var name = h('span', null, row[1]);
    var val = h('span', 'sc-value');
    label.append(name, val);
    cell.appendChild(label);

    var input = h('input');
    input.type = 'range';
    input.id = 'ws-' + path.replace('.', '-');
    input.min = String(row[2]);
    input.max = String(row[3]);
    input.step = String(row[4]);
    input.value = String(value);

    var paint = function (v) {
      val.textContent = num(v, row[4] < 1 ? 2 : 0) + (row[5] || '');
      var pct = row[3] > row[2] ? (Number(v) - row[2]) / (row[3] - row[2]) * 100 : 0;
      input.style.setProperty('--fill', pct.toFixed(1) + '%');
    };
    paint(value);
    input.addEventListener('input', function () {
      paint(input.value);
      onChange(Number(input.value));
    });
    // dblclick 回默认值：调歪了想找回来是高频动作，比"清空重来"省太多事。
    input.addEventListener('dblclick', function () {
      input.value = String(row[6]);
      paint(row[6]);
      onChange(row[6]);
    });
    cell.appendChild(input);
    var reset = h('button', 'ws-value-reset', '重置'); reset.type = 'button';
    reset.setAttribute('aria-label', '重置' + row[1]);
    reset.addEventListener('click', function () { input.value = String(row[6]); paint(row[6]); onChange(row[6]); input.dispatchEvent(new Event('change')); });
    cell.appendChild(reset);
    return cell;
  }

  function toggle(label, on, onChange) {
    var cell = h('div', 'sc-cell is-toggle');
    var lab = h('label', 'sc-label');
    lab.appendChild(h('span', null, label));
    cell.appendChild(lab);
    var sw = h('button', 'sc-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', label);
    sw.setAttribute('aria-checked', String(!!on));
    sw.classList.toggle('on', !!on);
    sw.addEventListener('click', function () {
      on = !on;
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(!!on));
      onChange(on);
    });
    cell.appendChild(sw);
    return cell;
  }

  function select(label, options, value, onChange) {
    var cell = h('div', 'sc-cell');
    var lab = h('label', 'sc-label');
    lab.textContent = label;
    cell.appendChild(lab);
    var wrap = h('div', 'sc-select-wrap');
    var sel = h('select');
    sel.id = 'ws-select-' + (++helpSeq);
    lab.htmlFor = sel.id;
    options.forEach(function (pair) {
      var o = h('option', null, pair[1]);
      o.value = String(pair[0]);
      sel.appendChild(o);
    });
    sel.value = String(value);
    sel.addEventListener('change', function () { onChange(sel.value); });
    wrap.appendChild(sel);
    cell.appendChild(wrap);
    return cell;
  }

  /** 参数路径下拉。带分组：镜头 / 影调 / 舞台 / 场景参数。 */
  function pathPicker(value, onChange) {
    var CS = stage_api();
    var spec = CS.spec();
    var sel = h('select', 'ws-path');
    var groups = spec.base.concat([{ id: 'sc', title: '场景参数', items: spec.scene }]);
    groups.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g.title;
      // 只列连续量。下拉型参数（色标）在绑定和 cue 里没有意义 —— 把 3.5
      // "缓动"进一个枚举没有定义，与其让用户发现拖不动，不如一开始就不给。
      (g.items || []).forEach(function (row) {
        var o = h('option', null, row[1]);
        o.value = row[0];
        og.appendChild(o);
      });
      if (og.children.length) sel.appendChild(og);
    });
    sel.value = value || (sel.children[0] && sel.children[0].children[0]
      ? sel.children[0].children[0].value : '');
    // 请求的路径在当前场景下不存在（比如从 towers 的 sc.height 切到 nebula）
    // 时，select.value = 一个不存在的值会得到空显示 —— 退回第一项，让面板
    // 至少是可读的，而不是一个空框。
    if (sel.value !== value) {
      var first = sel.querySelector('option');
      if (first) sel.value = first.value;
    }
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  function findRow(path) {
    var spec = stage_api().spec();
    var all = spec.base.concat([{ items: spec.scene }]);
    for (var i = 0; i < all.length; i += 1) {
      var items = all[i].items || [];
      for (var j = 0; j < items.length; j += 1) if (items[j][0] === path) return items[j];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 页签内容
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 一句成景：离线提示词 → StageIntent → applyIntent。
  //
  // 本页是解释器，不是另一个舞台编辑器：识别词典、冲突与否定规则全部住在
  // creative-prompt.js，写入走 CreativeStage.applyIntent 这一个原子口。
  // 这里只负责输入、解释、确认与撤销 —— 不直接逐项 setParam。
  //
  // 状态放在 promptState（模块级）：预置事件会触发整个面板重排，textarea、
  // 解析结果与撤销快照必须能原样重建；输入再次改变时解析结果作废。
  // -------------------------------------------------------------------------

  var promptState = { text: '', result: null, undo: null };

  var PROMPT_EXAMPLES = [
    '梦幻星云，缓慢镜头，霓虹，跟随音乐',
    '高速隧道，强烈节拍，近景，不要颗粒',
    '歌词走廊，安静，单色，固定镜头',
    '手绘地形，远景，不要抖动'
  ];

  var PROMPT_GROUPS = [
    ['scene', '场景'], ['energy', '氛围'], ['camera', '镜头'],
    ['look', '质感'], ['hand', '手绘'], ['director', '音乐响应']
  ];

  function renderPrompt(body) {
    var CP = window.CreativePrompt;
    body.appendChild(h('div', 'sc-note',
      '用一句中文或英文描述想要的舞台。识别是离线、确定性的：只认支持的词，'
      + '解析不改动舞台，点「应用到当前舞台」才生效，且可整体撤销。'));

    if (!CP || typeof CP.compile !== 'function') {
      body.appendChild(h('div', 'sc-note ws-warn',
        '提示词模块未加载，本页暂不可用；其它页签不受影响。'));
      return;
    }

    var inputId = 'ws-prompt-text';
    var label = h('label', 'sc-label');
    label.setAttribute('for', inputId);
    label.appendChild(h('span', null, '舞台描述'));
    body.appendChild(label);

    var ta = h('textarea', 'ws-prompt-text');
    ta.id = inputId;
    ta.maxLength = 120;
    ta.spellcheck = false;
    ta.value = promptState.text;
    ta.placeholder = '例：梦幻星云，缓慢镜头，霓虹，跟随音乐';
    body.appendChild(ta);

    var count = h('span', 'sc-value', promptState.text.length + ' / 120');
    var metaRow = h('div', 'ws-prompt-meta');
    metaRow.appendChild(count);
    body.appendChild(metaRow);

    var chips = h('div', 'ws-chips');
    PROMPT_EXAMPLES.forEach(function (text) {
      var chip = h('button', 'ws-chip', text);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        // 示例短语只填充：解析与应用都是用户显式的动作
        ta.value = text;
        syncInput(text);
      });
      chips.appendChild(chip);
    });
    body.appendChild(chips);

    var actions = h('div', 'ws-prompt-actions');
    var parseBtn = h('button', 'btn primary', '解析');
    parseBtn.type = 'button';
    var applyBtn = h('button', 'btn primary', '应用到当前舞台');
    applyBtn.type = 'button';
    applyBtn.disabled = !(promptState.result && promptState.result.ok);
    var undoBtn = h('button', 'btn', '撤销本次应用');
    undoBtn.type = 'button';
    undoBtn.hidden = !promptState.undo;
    actions.append(parseBtn, applyBtn, undoBtn);
    body.appendChild(actions);

    var resultBox = h('div', 'ws-prompt-result');
    resultBox.setAttribute('aria-live', 'polite');
    body.appendChild(resultBox);

    function syncInput(value) {
      promptState.text = String(value).slice(0, 120);
      count.textContent = promptState.text.length + ' / 120';
      // 输入再次改变：上一次的解析结果作废，避免拿旧解释应用新文本
      promptState.result = null;
      resultBox.textContent = '';
      applyBtn.disabled = true;
    }
    ta.addEventListener('input', function () { syncInput(ta.value); });

    // 摘要永远从 promptState.result 回放：应用成功会广播 preset 事件并触发面板
    // 重排，重建后的页面必须还能看到"刚才识别了什么、为什么这么应用"。
    function renderResult() {
      var r = promptState.result;
      resultBox.textContent = '';
      if (!r) return;
      if (!r.ok) {
        resultBox.appendChild(h('div', 'sc-note ws-warn',
          r.code === 'empty' ? '没有可识别的文本。' : '没有命中任何支持的词，舞台未改动。'));
        if (r.unknown && r.unknown.length) {
          resultBox.appendChild(h('div', 'ws-prompt-unknown',
            '未识别：' + r.unknown.join('、')));
        }
        resultBox.appendChild(h('div', 'sc-note',
          '只认这些词：场景（塔林/星球/隧道/星云/地形/歌词走廊）、氛围（安静/律动/爆发）、'
          + '镜头（近景/远景/广角/缓慢/高速）、质感（霓虹/单色/双色/胶片/干净）、'
          + '手绘、跟随音乐/固定镜头，以及"不要抖动/颗粒/泛光"。'));
        return;
      }
      resultBox.appendChild(h('div', 'ws-prompt-head', '识别结果'));
      var byGroup = {};
      r.matches.forEach(function (m) {
        if (!byGroup[m.group]) byGroup[m.group] = [];
        if (byGroup[m.group].indexOf(m.label) < 0) byGroup[m.group].push(m.label);
      });
      PROMPT_GROUPS.forEach(function (g) {
        var line = h('div', 'ws-kv');
        line.appendChild(h('span', null, g[1]));
        var got = byGroup[g[0]];
        line.appendChild(h('span', 'sc-value',
          got && got.length ? got.join('、') : '未提及（保留现状）'));
        resultBox.appendChild(line);
      });
      if (byGroup.negative) {
        var neg = h('div', 'ws-kv');
        neg.appendChild(h('span', null, '否定'));
        neg.appendChild(h('span', 'sc-value', byGroup.negative.join('、') + '（置零）'));
        resultBox.appendChild(neg);
      }
      (r.warnings || []).forEach(function (w) {
        resultBox.appendChild(h('div', 'sc-note ws-warn', w));
      });
      if (r.unknown && r.unknown.length) {
        resultBox.appendChild(h('div', 'ws-prompt-unknown',
          '未识别（不会应用）：' + r.unknown.join('、')));
      }
      resultBox.appendChild(h('div', 'sc-note',
        '未提到的 cue、绑定、背景、名称全部保留；切场景只换场景默认值与入画机位。'));
    }

    parseBtn.addEventListener('click', function () {
      var text = (ta.value || '').slice(0, 120);
      var r;
      try {
        r = CP.compile(text);
      } catch (e) {
        flash('解析失败：' + (e && e.message || e));
        return;
      }
      promptState.result = r;
      renderResult();
      applyBtn.disabled = !r.ok;
    });

    applyBtn.addEventListener('click', function () {
      var r = promptState.result;
      if (!r || !r.ok) return;
      var CS = stage_api();
      if (!CS || typeof CS.applyIntent !== 'function') {
        flash('舞台模块不可用，未改动');
        return;
      }
      var before = CS.preset();          // 撤销快照先于任何写入取出
      // 先挂上快照再应用：applyIntent 内部会同步广播 preset 事件并触发面板重排，
      // 重排时撤销按钮就必须已经可见。失败时回滚快照（失败不广播，无需重排）。
      var prevUndo = promptState.undo;
      promptState.undo = before;
      var out;
      try {
        out = CS.applyIntent(r.intent);
      } catch (e) {
        promptState.undo = prevUndo;
        flash('应用失败：' + (e && e.message || e));
        return;
      }
      if (!out || !out.ok) {
        promptState.undo = prevUndo;
        // 仅成功才保留新快照；失败时之前的撤销能力原样保留
        flash(out && out.message ? '未应用：' + out.message : '该意图无法应用，舞台未改动');
        return;
      }
      flash('已应用'
        + (r.intent.scene ? '（场景：' + r.intent.scene + '）' : '')
        + '，可撤销本次改动');
      // preset 事件会触发面板重排，撤销按钮随 promptState.undo 出现
    });

    undoBtn.addEventListener('click', function () {
      var snap = promptState.undo;
      if (!snap) return;
      var CS = stage_api();
      if (!CS) return;
      // 先清快照再恢复：setPreset 会同步广播 preset 事件并触发面板重排，
      // 重排时按钮就必须已经回到隐藏态。
      promptState.undo = null;
      try {
        CS.setPreset(snap);
      } catch (e) {
        promptState.undo = snap;    // 恢复失败时保住撤销能力，舞台未动
        flash('撤销失败：' + (e && e.message || e));
        return;
      }
      flash('已撤销本次应用');
      // setPreset 的 preset 事件触发重排，按钮随之隐藏
    });

    // 重排重建时回放已有解析结果（应用/撤销都会触发一次重排）
    renderResult();
  }

  // -------------------------------------------------------------------------
  // AI 生成（R4-E 任务面板）：服务端持久任务 + 提案。离线「一句成景」覆盖
  // 不到的云端生成走这里：submit → 任务列表（WS 事件 + 轮询双通道）→
  // succeeded 后读提案 → 应用到舞台或拒绝。离开面板任务继续跑，回来看结果。
  // 面板消费 /v1/ai/*，候选经同一草稿校验与临时预览入口，确认后由原 owner 提交。
  // -------------------------------------------------------------------------

  // Local draft state never creates a server job or writes the preset until confirmation.
  var draftState = { text: '', prepared: null, token: null, source: null, error: '', busy: false, serial: 0 };
  function isTemplateSource(source) { return typeof source === 'string' && source.indexOf('template:') === 0; }
  function isAiDraftSource(source) { return !!source && source !== 'import' && !isTemplateSource(source); }
  function prepareDraftSource(input, source) {
    return isTemplateSource(source) ? CreativeTemplates.prepare(source.slice(9)) : CreativeDraft.prepare(input);
  }
  function discardDraft() {
    draftState.serial += 1; draftState.prepared = null; draftState.token = null;
    draftState.busy = false; draftState.error = '';
    var CS = stage_api(); if (CS && CS.cancelPreview) CS.cancelPreview();
  }
  async function previewDraft(input, source) {
    discardDraft(); draftState.source = source; draftState.busy = true;
    var serial = draftState.serial, page = target + ':' + tab, CS = stage_api(), revision = CS.revision();
    render();
    try {
      var prepared = await prepareDraftSource(input,source);
      if (serial !== draftState.serial || !isOpen() || document.hidden || page !== target + ':' + tab) return;
      if (revision !== CS.revision()) throw new Error('舞台已修改，请重新预览');
      var current = CS.preset();
      prepared.diff = [{ path: 'name', before: current.name, after: prepared.preset.name },
        { path: 'scene', before: current.scene, after: prepared.preset.scene },
        { path: 'director', before: current.director, after: prepared.preset.director },
        { path: 'hand.on', before: current.hand.on, after: prepared.preset.hand.on }];
      prepared.diagnostics.forEach(function (d) {
        var parts = d.path.split('.');
        prepared.diff.push({ path: d.path, before: current[parts[0]][parts[1]], after: d.normalized });
      });
      draftState.prepared = prepared;
      draftState.token = CS.beginPreview(prepared.preset, prepared.proposalHash);
    } catch (e) { if (serial === draftState.serial) draftState.error = String(e.message || e); }
    finally { if (serial === draftState.serial) { draftState.busy = false; render(); } }
  }
  function renderDraftControls(body, source) {
    if (draftState.source !== source) return;
    if (draftState.error) body.appendChild(h('div', 'sc-note ws-warn', draftState.error));
    var prepared = draftState.prepared, token = draftState.token, CS = stage_api();
    if (!prepared || !token || !CS.preview() || CS.preview().previewId !== token.previewId) return;
    if (prepared.template) {
      body.appendChild(h('p','sc-note',prepared.template.source + ' · ' + prepared.template.title + ' v'
        + prepared.template.version + ' · 舞台契约 v' + prepared.template.schemaVersion + ' · 待视觉验收'));
      body.appendChild(h('p','sc-note','从模板的默认基线创建。应用会替换整份预置，包括旧 cue、绑定和工程上下文；原曲目不会自动播放或切换。'));
    }
    body.appendChild(h('div', 'sc-note', '正在临时预览。确认应用后才会保存；切页、关闭或取消会恢复已提交的舞台。'));
    (prepared.diff || []).filter(function (d) { return d.before !== d.after; }).forEach(function (d) {
      body.appendChild(h('div', 'ws-kv', d.path + '：当前 ' + d.before + ' → 候选 ' + d.after));
    });
    prepared.diagnostics.forEach(function (d) {
      body.appendChild(h('div', d.clamped ? 'ws-kv ws-warn' : 'ws-kv',
        d.path + '：' + d.requested + ' → ' + d.normalized + (d.clamped ? '（已调整到支持范围）' : '')));
    });
    var detail = h('details'), title = h('summary', null, '查看完整候选与分享码');
    var code = h('textarea', 'ws-json'); code.readOnly = true; code.value = prepared.shareCode;
    code.setAttribute('aria-label', '草稿分享码');
    var json = h('pre', 'sc-note', JSON.stringify(prepared.preset, null, 2));
    detail.append(title, code, json); body.appendChild(detail);
    var row = h('div', 'ws-prompt-actions');
    var apply = h('button', 'btn primary', '应用到当前舞台'); apply.type = 'button';
    apply.addEventListener('click', async function () {
      if (draftState.busy) return;
      var serial = draftState.serial;
      draftState.busy = true; apply.disabled = true;
      try {
        var checked = await prepareDraftSource(prepared.artifact,source);
        if (isAiDraftSource(source)) {
          var latest = await VMusicTransport.get('/v1/ai/proposals/' + source);
          if (latest.state !== 'pending' || latest.expiresAt <= Date.now()
            || CreativeDraft.canonical(latest.artifact) !== CreativeDraft.canonical(prepared.artifact)) {
            throw new Error('提案已失效，请重新读取');
          }
        }
        if (serial !== draftState.serial) return;
        if (!isOpen() || document.hidden || checked.proposalHash !== token.proposalHash) throw new Error('预览已失效');
        var previous = CS.preset();
        var result = CS.applyPreview(token.previewId, checked.proposalHash);
        if (!result.ok) throw new Error(result.message);
        if (isAiDraftSource(source)) aiState.undo = previous;
        discardDraft(); flash('已应用到本页面；收藏请使用原收藏入口');
      } catch (e) {
        if (serial === draftState.serial) { draftState.error = String(e.message || e); }
      } finally {
        if (serial === draftState.serial) draftState.busy = false;
        render();
      }
    });
    var cancel = h('button', 'btn', '取消预览'); cancel.type = 'button';
    cancel.addEventListener('click', function () { discardDraft(); render(); });
    row.append(apply, cancel); body.appendChild(row);
  }
  function renderDraftImport(body) {
    body.appendChild(h('h2', 'sc-group-title', '导入舞台意图草稿'));
    body.appendChild(h('div', 'sc-note', '粘贴带版本信息的草稿 JSON（最多 16 KiB）。本地校验并临时预览，无需开启生成或外部连接。'));
    var ta = h('textarea', 'ws-json'); ta.id = 'ws-draft-json'; ta.spellcheck = false;
    ta.value = draftState.text; ta.setAttribute('aria-label', '舞台意图草稿 JSON');
    ta.addEventListener('input', function () {
      var active = draftState.token || draftState.busy || draftState.error;
      draftState.text = ta.value; discardDraft(); if (active) render();
    });
    var preview = h('button', 'btn primary', draftState.busy ? '正在校验…' : '校验并预览草稿');
    preview.type = 'button'; preview.id = 'ws-draft-preview'; preview.disabled = draftState.busy;
    preview.addEventListener('click', function () { previewDraft(draftState.text, 'import'); });
    body.append(ta, preview); renderDraftControls(body, 'import');
  }

  var aiState = {
    jobs: [], consent: false, guard: null, budget: null, provider: null, expanded: null,
    proposal: null, brief: '', loading: false, error: '',
    snapshot: '', undo: null, pendingSubmit: null,
  };
  var aiTimer = 0, aiRefresh = null, aiRefreshAgain = false;
  var aiErrorRetryDelay = 2500, aiErrorRetryAt = 0;

  function aiVisible() {
    return isOpen() && target === 'advanced' && tab === 'ai' && !document.hidden;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { discardDraft(); if (isOpen()) render(); }
    if (aiVisible()) refreshAi();
  });

  function aiStateLabel(state) {
    return {
      accepted: '排队中', running: '生成中', succeeded: '已完成',
      failed: '失败', cancelled: '已取消', expired: '已超时', interrupted: '已中断',
    }[state] || state;
  }

  function aiShortId(id) {
    return String(id || '').slice(0, 8);
  }

  function aiTime(ms) {
    var d = new Date(Number(ms) || 0);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function refreshAi() {
    var T = window.VMusicTransport;
    if (!T) return Promise.resolve();
    if (aiRefresh) { aiRefreshAgain = true; return aiRefresh; }
    aiRefresh = T.get('/v1/ai/status')
      .then(function (status) {
        aiState.consent = !!(status.consent && status.consent.inAppGeneration);
        aiState.guard = status.guard || null;
        aiState.budget = status.budget || null;
        aiState.provider = status.provider || null;
        return T.get('/v1/ai/jobs?limit=20');
      })
      .then(function (data) {
        aiState.jobs = (data && data.jobs) || [];
        if (aiState.expanded) {
          var id = aiState.expanded;
          return T.get('/v1/ai/proposals/' + id).then(function (proposal) {
            if (aiState.expanded === id) aiState.proposal = proposal;
          });
        }
      })
      .then(function () {
        aiState.error = '';
        aiErrorRetryDelay = 2500;
        aiErrorRetryAt = 0;
        renderIfChanged();
      })
      .catch(function (e) {
        aiState.error = String((e && e.message) || e);
        aiErrorRetryAt = Date.now() + aiErrorRetryDelay;
        aiErrorRetryDelay = Math.min(15000, aiErrorRetryDelay * 2);
        renderIfChanged();
      })
      .then(function () {
        aiRefresh = null;
        var again = aiRefreshAgain;
        aiRefreshAgain = false;
        if (again && aiVisible()) return refreshAi();
      });
    return aiRefresh;
  }

  /// 快照比较：轮询拿到同样的事实就不重画——2.5 秒撕一次 DOM 会把用户
  /// 正在点的按钮从手底下抽走。展开态与错误信息都参与比较。
  function renderIfChanged() {
    var fingerprint = JSON.stringify([
      aiState.jobs.map(function (job) {
        return [job.jobId, job.state, job.stateRevision, job.resultProposalId, job.usage];
      }),
      aiState.consent, aiState.guard, aiState.budget, aiState.provider, aiState.error,
      aiState.expanded, aiState.proposal, aiState.undo,
    ]);
    if (fingerprint === aiState.snapshot) return;
    aiState.snapshot = fingerprint;
    if (aiVisible()) render();
  }

  function clearAiCredential() {
    var input = document.getElementById('ws-ai-key');
    if (input) input.value = '';
  }

  function renderAiCredential(body, T) {
    var details = h('details', 'ws-ai-credential');
    details.appendChild(h('summary', 'sc-label', 'OpenAI 密钥设置（接入准备）'));
    details.appendChild(h('p', 'sc-note',
      '密钥保存在系统钥匙串，仅绑定本安装与 https://api.openai.com。模型与费用上限尚未确定，保存密钥不会开启云端生成。'));
    var status = h('p', 'sc-note', '展开后只显示是否已配置，服务端不回传密钥。');
    status.setAttribute('aria-live', 'polite');
    var label = h('label', 'sc-label', 'OpenAI API key');
    label.setAttribute('for', 'ws-ai-key');
    var input = h('input', 'ws-prompt-text');
    input.id = 'ws-ai-key'; input.type = 'password'; input.autocomplete = 'off';
    input.maxLength = 4096; input.spellcheck = false;
    input.setAttribute('autocapitalize', 'none');
    var actions = h('div', 'ws-prompt-actions');
    var save = h('button', 'btn', '保存 OpenAI 密钥');
    var remove = h('button', 'btn', '删除 OpenAI 密钥');
    var query = h('button', 'btn', '查询密钥状态');
    [save, remove, query].forEach(function (button) { button.type = 'button'; actions.appendChild(button); });
    var busy = false, revision = 0;
    function valid(serial) { return serial === revision && details.isConnected && details.open && aiVisible(); }
    function buttons() { save.disabled = busy || !input.value; remove.disabled = query.disabled = input.disabled = busy; }
    function run(method) {
      if (busy) return;
      var serial = ++revision;
      busy = true; buttons(); status.textContent = '正在操作系统钥匙串…';
      var task;
      if (method === 'PUT') {
        task = T.put('/v1/ai/provider-credential', { api_key: input.value });
        input.value = ''; // No secret in module state, retry state or browser storage.
      } else if (method === 'DELETE') {
        input.value = '';
        task = T.del('/v1/ai/provider-credential');
      } else task = T.get('/v1/ai/provider-credential', { retry: false });
      Promise.resolve(task).then(function (reply) {
        if (valid(serial)) status.textContent = reply.configured ? '已配置 OpenAI 密钥；云端生成尚未启用。' : '尚未配置 OpenAI 密钥。';
      }).catch(function (error) {
        if (!valid(serial)) return;
        var messages = {
          ai_locked: '请在持有 AI 服务锁的 Hertz 实例中管理模型密钥；当前实例无法执行。',
          ai_credential_invalid: '密钥格式不合法，请重新输入；不允许空白或控制字符。',
          ai_credential_busy: '钥匙串操作仍在执行，请稍后手动查询状态。',
          ai_credential_timeout: '钥匙串操作尚未结束，结果待确认；请稍后手动查询状态。',
          ai_credential_unavailable: '系统钥匙串不可用，请检查系统凭据服务。',
        };
        status.textContent = (messages[error.code] || '操作未确认，请手动查询状态后再决定是否重新提交。')
          + (error.requestId ? '（request_id ' + error.requestId + '）' : '');
      }).then(function () { busy = false; if (details.isConnected) buttons(); });
    }
    input.addEventListener('input', buttons);
    save.addEventListener('click', function () { run('PUT'); });
    remove.addEventListener('click', function () { run('DELETE'); });
    query.addEventListener('click', function () { run('GET'); });
    details.addEventListener('toggle', function () {
      if (details.open) run('GET');
      else { input.value = ''; revision += 1; }
    });
    buttons(); details.append(status, label, input, actions); body.appendChild(details);
  }

  function renderAi(body) {
    var T = window.VMusicTransport;
    if (!T) {
      body.appendChild(h('div', 'sc-note ws-warn', 'transport 未就绪，本页暂不可用。'));
      return;
    }
    if (!aiTimer && aiVisible()) {
      // 事件是提示，轮询是事实来源（§7.4）：事件允许丢失/乱序，列表以
      // 查询快照为准；面板开着时低频轮询兜底。
      aiTimer = setInterval(function () {
        if (!aiVisible()) return;
        if (aiState.error) {
          if (Date.now() >= aiErrorRetryAt) refreshAi();
          return;
        }
        if (aiState.expanded || aiState.jobs.some(function (j) {
          return j.state === 'accepted' || j.state === 'running' || (j.usage && j.usage.usageState === 'unknown');
        })) refreshAi();
      }, 2500);
      refreshAi();
    }

    body.appendChild(h('div', 'sc-note',
      '把描述交给服务端生成（实验）：任务在后台跑，离开面板不影响，回来在这里看结果。'
      + '功能默认关闭，开关在下方；先查看候选参数，点「应用」才上舞台，且可整体撤销。'));

    if (aiState.error) {
      body.appendChild(h('div', 'sc-note ws-warn', aiState.error));
    }

    var consentRow = h('div', 'ws-kv');
    consentRow.appendChild(h('span', null, '生成开关'));
    consentRow.appendChild(h('span', 'sc-value', aiState.consent ? '已开启' : '已关闭'));
    body.appendChild(consentRow);
    var toggle = h('button', 'btn', aiState.consent ? '关闭生成' : '开启生成');
    toggle.type = 'button';
    toggle.disabled = aiState.loading;
    toggle.addEventListener('click', function () {
      setLoading(true);
      T.put('/v1/settings', { ai_generation_consent: !aiState.consent })
        .then(function () { return refreshAi(); })
        .catch(function (e) { flash('保存失败：' + String((e && e.message) || e)); })
        .then(function () { setLoading(false); });
    });
    body.appendChild(toggle);

    function usd(micro) {
      return Number.isSafeInteger(micro) && micro >= 0
        ? '$' + (micro / 1000000).toFixed(6) + ' USD' : '金额暂不可显示';
    }
    if (aiState.provider && aiState.provider.id === 'fake') {
      body.appendChild(h('div', 'sc-note', '当前为本地模拟生成，不调用真实模型，费用为零。'));
    } else if (aiState.provider && aiState.provider.id === 'ollama-local') {
      body.appendChild(h('div', 'sc-note', '当前使用本地 Ollama 模型：' + aiState.provider.model
        + '。仅发送生成描述与舞台参数契约，不读取歌曲、歌词或音频；Hertz 不计云端费用。'));
    } else if (aiState.provider && !aiState.provider.ready) {
      body.appendChild(h('div', 'sc-note ws-warn', '生成服务配置不可用：'
        + (aiState.provider.diagnostic || '请检查服务配置')));
    }
    renderAiCredential(body, T);
    if (aiState.budget) {
      var budget = aiState.budget;
      var charged = budget.chargedTotalOverflowed ? '超出可表示范围' : usd(budget.chargedMicroUsd);
      var budgetLine = h('div', 'sc-note ws-ai-budget',
        '预算周期：' + budget.month + '（UTC 自然月） · 已计 ' + charged
        + ' · 在途预留 ' + usd(budget.reservedMicroUsd) + ' · 月限额 ' + usd(budget.limitMicroUsd));
      body.appendChild(budgetLine);
    }
    var refreshBtn = h('button', 'btn', '刷新任务与费用');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', function () { refreshAi(); });
    body.appendChild(refreshBtn);

    if (aiState.guard && aiState.guard.halted) {
      body.appendChild(h('div', 'sc-note ws-warn',
        '生成已熔断（' + (aiState.guard.reason || '预算越界') + '），复位后才能继续。'));
      var resetBtn = h('button', 'btn', '复位熔断');
      resetBtn.type = 'button';
      resetBtn.addEventListener('click', function () {
        T.post('/v1/ai/budget-guard/reset', { expected_revision: aiState.guard.revision })
          .then(function () { return refreshAi(); })
          .catch(function (e) { flash('复位失败：' + String((e && e.message) || e)); });
      });
      body.appendChild(resetBtn);
    }

    var label = h('label', 'sc-label');
    label.setAttribute('for', 'ws-ai-brief');
    label.appendChild(h('span', null, '生成描述'));
    body.appendChild(label);
    var ta = h('textarea', 'ws-prompt-text');
    ta.id = 'ws-ai-brief';
    ta.maxLength = 2000;
    ta.spellcheck = false;
    ta.value = aiState.brief;
    ta.placeholder = '例：星云缓慢推进，霓虹颗粒，跟随音乐律动';
    ta.addEventListener('input', function () {
      aiState.brief = String(ta.value).slice(0, 2000);
      syncAiButtons();
    });
    body.appendChild(ta);

    var actions = h('div', 'ws-prompt-actions');
    var submitBtn = h('button', 'btn primary', '提交生成任务');
    submitBtn.type = 'button';
    // consent 关闭时输入框与提交一起禁用：面板状态本身就是开关的可见面。
    function syncAiButtons() {
      ta.disabled = !aiState.consent;
      submitBtn.disabled = !aiState.consent || aiState.loading || !aiState.brief.trim()
        || !!(aiState.provider && !aiState.provider.ready);
    }
    submitBtn.disabled = !aiState.consent || aiState.loading || !aiState.brief.trim();
    submitBtn.addEventListener('click', function () {
      var brief = aiState.brief.trim();
      if (!aiState.pendingSubmit || aiState.pendingSubmit.brief !== brief) {
        var hex = '';
        Array.prototype.forEach.call(crypto.getRandomValues(new Uint8Array(16)), function (b) {
          hex += ('0' + b.toString(16)).slice(-2);
        });
        aiState.pendingSubmit = { brief: brief, key: 'v1.' + Date.now() + '.' + hex };
      }
      var pending = aiState.pendingSubmit;
      setLoading(true);
      T.post('/v1/ai/jobs', { brief: pending.brief, idempotency_key: pending.key })
        .then(function () {
          aiState.pendingSubmit = null;
          if (aiState.brief.trim() === pending.brief) aiState.brief = '';
          ta.value = aiState.brief;
          return refreshAi();
        })
        .catch(function (e) { flash('提交失败：' + String((e && e.message) || e)); })
        .then(function () { setLoading(false); });
    });
    actions.appendChild(submitBtn);
    body.appendChild(actions);

    var list = h('div', 'ws-ai-jobs');
    list.setAttribute('aria-live', 'polite');
    body.appendChild(list);
    if (!aiState.jobs.length) {
      list.appendChild(h('div', 'sc-note', '还没有任务。'));
    }
    aiState.jobs.forEach(function (job) {
      var row = h('div', 'ws-ai-job');
      row.appendChild(h('span', 'ws-ai-state', aiStateLabel(job.state)));
      row.appendChild(h('span', 'sc-value',
        aiShortId(job.jobId) + ' · ' + aiTime(job.createdAt) + ' · ' + job.provider + '/' + job.model));
      list.appendChild(row);
      if (job.usage) {
        var usage = job.usage;
        var usageText = {
          reserved: '在途预留 ' + usd(usage.reservationMicroUsd),
          reported: '已报告费用 ' + usd(usage.accountedMicroUsd),
          released: '未派发，预留已释放',
          unknown: '费用未确认，暂按 ' + usd(usage.accountedMicroUsd) + ' 计入预算，后续可能校正',
          estimated_final: '估算费用 ' + usd(usage.accountedMicroUsd) + '，已停止自动等待；取得可信记录后仍可校正',
        }[usage.usageState] || '费用状态待查询';
        list.appendChild(h('div', 'sc-note ws-ai-usage', usageText + ' · 归属 ' + usage.acceptedMonth + '（UTC）'));
      }

      var ops = h('div', 'ws-ai-ops');
      if (job.state === 'accepted' || job.state === 'running') {
        var cancelBtn = h('button', 'btn', '取消');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', function () {
          T.post('/v1/ai/jobs/' + job.jobId + '/cancel',
            { expected_state_revision: job.stateRevision })
            .then(function () { return refreshAi(); })
            .catch(function (e) { flash('取消失败：' + String((e && e.message) || e)); });
        });
        ops.appendChild(cancelBtn);
      }
      if (job.state === 'succeeded' && job.resultProposalId) {
        var viewBtn = h('button', 'btn primary',
          aiState.expanded === job.resultProposalId ? '收起提案' : '查看提案');
        viewBtn.type = 'button';
        viewBtn.addEventListener('click', function () {
          if (aiState.expanded === job.resultProposalId) {
            discardDraft();
            aiState.expanded = null;
            aiState.proposal = null;
            render();
            return;
          }
          discardDraft();
          aiState.expanded = job.resultProposalId;
          aiState.proposal = null;
          renderIfChanged();
          T.get('/v1/ai/proposals/' + job.resultProposalId)
            .then(function (proposal) {
              if (aiState.expanded !== job.resultProposalId) return;
              aiState.proposal = proposal;
              renderIfChanged();
            })
            .catch(function (e) { flash('读取提案失败：' + String((e && e.message) || e)); });
        });
        ops.appendChild(viewBtn);
      }
      if (ops.children.length) list.appendChild(ops);

      if (aiState.expanded && aiState.expanded === job.resultProposalId) {
        var box = h('div', 'ws-ai-proposal');
        box.setAttribute('aria-live', 'polite');
        var proposal = aiState.proposal && aiState.proposal.proposalId === job.resultProposalId
          ? aiState.proposal : null;
        if (!proposal) {
          box.appendChild(h('div', 'sc-note', '读取提案中…'));
        } else if (proposal.state !== 'pending') {
          box.appendChild(h('div', 'sc-note', '提案状态：' + proposal.state));
        } else {
          var intent = proposal.validatedIntent || {};
          box.appendChild(h('div', 'ws-prompt-head', '提案 · 场景：' + (intent.scene || '—')));
          var patch = intent.patch || {};
          Object.keys(patch).forEach(function (key) {
            var line = h('div', 'ws-kv');
            line.appendChild(h('span', null, key));
            line.appendChild(h('span', 'sc-value', String(patch[key])));
            box.appendChild(line);
          });
          var proposalOps = h('div', 'ws-prompt-actions');
          var applyBtn = h('button', 'btn primary', '预览候选舞台');
          applyBtn.type = 'button'; applyBtn.disabled = draftState.busy;
          applyBtn.addEventListener('click', function () {
            if (proposal.expiresAt <= Date.now()) { refreshAi(); flash('提案已过期'); return; }
            if (!proposal.artifact) { flash('旧提案缺少版本信息，请重新生成'); return; }
            previewDraft(proposal.artifact, proposal.proposalId);
          });
          var rejectBtn = h('button', 'btn', '拒绝');
          rejectBtn.type = 'button';
          rejectBtn.addEventListener('click', function () {
            if (draftState.source === proposal.proposalId) discardDraft();
            T.post('/v1/ai/proposals/' + proposal.proposalId + '/reject',
              { expected_revision: proposal.revision })
              .then(function (updated) {
                if (aiState.expanded === updated.proposalId) aiState.proposal = updated;
                renderIfChanged();
                return refreshAi();
              })
              .catch(function (e) { flash('拒绝失败：' + String((e && e.message) || e)); });
          });
          proposalOps.append(applyBtn, rejectBtn);
          box.appendChild(proposalOps);
          renderDraftControls(box, proposal.proposalId);
          box.appendChild(h('div', 'sc-note',
            '候选从默认基线物化后整体应用，可整体撤销；提案 24 小时后过期。'));
        }
        list.appendChild(box);
      }
    });

    function setLoading(on) {
      var changed = aiState.loading !== on;
      aiState.loading = on;
      toggle.disabled = on;
      syncAiButtons();
      if (changed && aiVisible()) render();
    }
    if (aiState.undo) {
      var undo = h('button', 'btn', '撤销本次应用');
      undo.type = 'button';
      undo.addEventListener('click', function () {
        var previous = aiState.undo;
        aiState.undo = null;
        try { stage_api().setPreset(previous); render(); flash('已撤销本次应用'); }
        catch (e) { aiState.undo = previous; flash('撤销失败：' + String(e && e.message || e)); }
      });
      body.appendChild(undo);
    }
    setLoading(aiState.loading);
  }

  /// 任务事件（WS ai_task）到达：面板开着就立刻刷新，其余场合等下次轮询。
  function onAiTask() {
    if (aiVisible()) refreshAi();
  }

  function renderScene(body) {
    var CS = stage_api();
    var cur = CS.preset();

    if (showAnimeScenery) renderAnimeGallery(body, CS, cur);

    var guide = guideCard();
    if (guide) body.appendChild(guide);

    body.appendChild(h('h2', 'sc-group-title', '当前舞台'));
    var nameRow = h('div', 'ws-row');
    var nameInput = h('input', 'ws-name');
    nameInput.type = 'text';
    nameInput.value = cur.name || '';
    nameInput.placeholder = '给这份舞台起个名字';
    // 改名走 renamePreset，而不是"读整份预置 → 改名字 → 写回去"。
    // 后者每次按键都会触发一次预置变更广播，面板监听到就重排 DOM，
    // 输入框随即失焦 —— 一个字符都打不进去。
    nameInput.addEventListener('input', function () {
      CS.renamePreset(nameInput.value);
    });
    nameRow.appendChild(nameInput);

    var saveBtn = h('button', 'btn primary', '存进工坊');
    saveBtn.addEventListener('click', function () {
      var p = CS.savePreset(nameInput.value || cur.name);
      flash('已保存「' + p.name + '」');
      render();
    });
    nameRow.appendChild(saveBtn);
    body.appendChild(nameRow);

    body.appendChild(h('p','sc-note','当前编排已提交并自动保存在本机，预置格式 v' + cur.version
      + (cur.project ? '，工程 / 时间线 v' + cur.project.version + ' / v' + cur.project.timelineVersion : '')
      + '。存进工坊会另建收藏；模板与草稿须先预览、确认应用，才会替换当前编排。'));
    renderCreativeTemplates(body);

    body.appendChild(h('h2', 'sc-group-title', '三维场景'));
    // 场景、参数和编排使用同一份创意预置，直接交给大舞台的渲染器。
    var grid = h('div', 'ws-scene-grid');
    if (CS.scenes) {
      CS.scenes().forEach(function (s) {
        if (s.presentation && s.presentation.family === 'anime') return;
        var card = h('button', 'ws-scene-card');
        card.type = 'button';
        card.dataset.scene = s.id;
        card.innerHTML = sceneArt(s.id);
        card.appendChild(h('strong', null, s.label));
        card.appendChild(h('small', null, SCENE_DESCRIPTIONS[s.id] || '镜头与光影跟随你的编排'));
        var on = cur.scene === s.id;
        card.classList.toggle('on', on);
        card.setAttribute('aria-pressed', String(on));
        card.addEventListener('click', function () {
          activateCreativeStage();
          CS.setScene(s.id);
          render();
        });
        grid.appendChild(card);
      });
      body.appendChild(grid);
      body.appendChild(h('div', 'sc-note',
        '场景、镜头、编排与电影风格直接呈现在大舞台，关闭工坊后继续演出。'));
    }

    var opts = h('div', 'sc-grid');
    opts.appendChild(toggle('自动导演', cur.director, function (v) {
      CS.setDirector(v);
      flash(v ? '导演已接管镜头与影调' : '导演已关闭，改由编排轨与手动控制');
    }));
    opts.appendChild(toggle('舞台交互（拖拽转视角）', CS.isInteract(), function (v) {
      CS.setInteract(v);
    }));
    body.appendChild(opts);
    body.appendChild(h('div', 'sc-note',
      '打开舞台交互后：拖拽转视角、滚轮推拉、单击爆闪、双击复位。'
      + '默认关闭是为了不抢歌词行的点击。'));

  }

  function renderCreativeTemplates(body) {
    if (!window.CreativeTemplates) return;
    var catalog = h('section','ws-template-catalog');
    catalog.appendChild(h('h2','sc-group-title','创作模板候选'));
    catalog.appendChild(h('p','sc-note','内置配方，先在舞台临时预览，确认后才应用。卡片插图仅示意场景；模板尚待人工视觉验收，不保证跨设备画面一致。'));
    var grid = h('div','ws-creative-templates');
    CreativeTemplates.list().forEach(function (t) {
      var card = h('article','ws-creative-template'); card.dataset.templateCard = t.id;
      var art = h('div','ws-creative-template-art'); art.innerHTML = sceneArt(t.scene); art.setAttribute('aria-hidden','true');
      card.append(art,h('h3',null,t.title),h('p','sc-note',t.mood + ' · ' + t.motion),h('p','sc-note',t.boundary),
        h('p','sc-note',t.source + ' · 模板 v' + t.version + ' · ' + (t.compatible ? '与本版本兼容' : '版本不兼容')));
      var details = h('details'), summary = h('summary',null,'来源与兼容信息');
      details.append(summary,h('p','sc-note','预置格式 v1 · 舞台契约 v' + t.schemaVersion + ' · 待视觉验收'),
        h('p','sc-note','契约 ' + t.schemaHash),h('p','sc-note','默认基线 ' + t.basePresetHash));
      var preview = h('button','btn','预览「' + t.title + '」'); preview.type = 'button'; preview.dataset.template = t.id;
      preview.disabled = !t.compatible || draftState.busy;
      preview.addEventListener('click',function () { previewDraft(null,'template:' + t.id); });
      card.append(details,preview); grid.appendChild(card);
    });
    catalog.appendChild(grid);
    if (isTemplateSource(draftState.source)) renderDraftControls(catalog,draftState.source);
    body.appendChild(catalog);
  }

  function renderAnimeGallery(body, CS, cur) {
    var scenes = CS.scenes().filter(function (s) { return s.presentation && s.presentation.family === 'anime'; });
    if (!scenes.length) return;
    var section = h('section', 'ws-anime-gallery');
    section.tabIndex = 0;
    section.setAttribute('aria-label', '动画绘景，空格暂停，左右方向键调速');
    section.setAttribute('aria-keyshortcuts', 'Space ArrowLeft ArrowRight');
    var heading = h('div', 'ws-anime-heading');
    heading.appendChild(h('span', 'ws-anime-kicker', 'SCENERY COLLECTION'));
    heading.appendChild(h('h2', null, '动画绘景'));
    heading.appendChild(h('p', null, '风与光缓缓流动，音乐有了栖身之处。'));
    section.appendChild(heading);
    var grid = h('div', 'ws-anime-grid');
    scenes.forEach(function (scene) {
      var info = scene.presentation;
      var card = h('button', 'ws-anime-card');
      card.type = 'button';
      card.id = 'ws-scene-' + scene.id;
      card.dataset.scene = scene.id;
      card.setAttribute('aria-pressed', String(cur.scene === scene.id));
      card.setAttribute('aria-label', scene.label);
      var preview = h('span', 'ws-anime-preview');
      preview.dataset.motion = 'paused';
      preview.dataset.inView = 'false';
      preview.innerHTML = info.art;
      var check = h('span', 'ws-anime-selected');
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="m5 10 3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      preview.appendChild(check);
      var caption = h('span', 'ws-anime-caption');
      caption.appendChild(h('span', 'ws-anime-tag', info.tag));
      caption.appendChild(h('strong', null, scene.label));
      caption.appendChild(h('span', 'ws-anime-description', info.description));
      card.append(preview, caption);
      card.addEventListener('click', function () {
        activateCreativeStage();
        if (CS.preset().scene !== scene.id) {
          CS.setScene(scene.id);
          // Use the existing art-direction action so a previous monochrome
          // treatment does not obscure this landscape's original palette.
          CS.setStyle('off');
        }
        flash('已入画 · ' + scene.label);
        render();
      });
      grid.appendChild(card);
    });
    section.appendChild(grid);
    var footer = h('div', 'ws-anime-footer');
    var note = h('p', 'ws-anime-note', '聚焦画册 · 空格暂停 · ← → 调速');
    var motion = h('button', 'ws-anime-motion-toggle', artPaused ? '继续动画' : '暂停动画');
    motion.type = 'button';
    motion.setAttribute('aria-pressed', String(artPaused));
    motion.setAttribute('aria-label', '暂停风景预览动画');
    motion.addEventListener('click', function () {
      artPaused = !artPaused;
      updateArtControls();
    });
    var speed = h('button', 'ws-anime-speed', artRate + '×');
    speed.type = 'button';
    speed.setAttribute('aria-label', '切换风景预览速度');
    speed.title = '切换速度，或使用左右方向键';
    speed.addEventListener('click', function () { artRate = artRate >= 1.5 ? .5 : artRate + .25; updateArtControls(); });
    var controls = h('span', 'ws-anime-controls');
    controls.append(motion, speed);
    footer.append(note, controls);
    section.appendChild(footer);
    body.appendChild(section);
  }

  function renderPresets(body) {
    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '工坊收藏'));
    head.appendChild(help('收藏只保存在本机；载入会立即替换当前舞台，删除前会再次确认。'));
    body.appendChild(head);
    body.appendChild(h('p','sc-note','本机收藏是另存的完整预置快照；载入会立即替换当前编排。旧收藏未记录来源与契约 hash 时，不推断其作者或兼容性。收藏不保存本次媒体确认，工程执行状态以导出页为准。'));
    renderPresetGallery(body, stage_api());
  }

  function renderPresetGallery(body, CS) {
    var lib = CS.library();
    if (!lib.length) {
      body.appendChild(h('div', 'sc-note', '还没有收藏。调好一份舞台后回到「场景」页点「存进工坊」。'));
      return;
    }

    var libGrid = h('div', 'ws-gallery');
    lib.forEach(function (p) {
      var card = h('div', 'ws-shot');
      if (p.thumb) {
        var img = h('img');
        img.src = p.thumb;
        img.alt = '';
        card.appendChild(img);
      } else {
        card.appendChild(h('div', 'ws-shot-empty', '无预览'));
      }
      card.appendChild(h('div', 'ws-shot-name', p.name || '未命名'));
      card.appendChild(h('p','sc-note','本机收藏 · 预置格式 v' + (p.version || '未知')
        + (p.project ? ' · 工程契约 v' + p.project.schemaVersion : ' · 未记录契约版本')));
      var btns = h('div', 'ws-shot-btns');
      var load = h('button', 'btn', '载入并应用');
      load.addEventListener('click', function () {
        CS.loadPresetById(p.id);
        flash('已载入');
        render();
      });
      var del = h('button', 'btn danger', '删除');
      del.addEventListener('click', async function () {
        // 插件 iframe 没有 allow-modals，原生 confirm 会被静默忽略（返回 false），
        // 于是删除按钮点了没反应。统一走 dialogs.js，独立形态下它委托给原生。
        var dialog = window.hertzDialog || window;
        if (!(await dialog.confirm('删除收藏「' + (p.name || '未命名') + '」？'))) return;
        CS.removePreset(p.id);
        render();
      });
      btns.append(load, del);
      card.appendChild(btns);
      libGrid.appendChild(card);
    });
    body.appendChild(libGrid);
  }

  function renderParams(body) {
    var CS = stage_api();
    var spec = CS.spec();

    var cur = CS.preset();

    var groups = spec.base.concat([{ id: 'sc', title: '场景参数（' + cur.scene + '）', items: spec.scene }]);
    groups.forEach(function (g) {
      var group = h('details', 'ws-param-group'); group.open = g.id === 'sc';
      group.appendChild(h('summary', null, g.title));
      var grid = h('div', 'sc-grid');
      (g.items || []).forEach(function (row) {
        var path = row[0];
        var parts = path.split('.');
        var value = cur[parts[0]] && cur[parts[0]][parts[1]];
        if (value === undefined) value = row[6];
        grid.appendChild(slider(row, value, function (v) {
          CS.setParam(path, v);
          lastParamPath = path;
        }));
      });
      (g.selects || []).forEach(function (row) {
        var path = row[0];
        var parts = path.split('.');
        var value = cur[parts[0]] && cur[parts[0]][parts[1]];
        if (value === undefined) value = row[3];
        grid.appendChild(select(row[1], row[2], value, function (v) {
          CS.setParam(path, Number(v));
        }));
      });
      group.appendChild(grid); body.appendChild(group);
    });

    body.appendChild(h('div', 'sc-note',
      '这里调整基础值；自动导演、绑定和编排会在演出时叠加变化。点击重置可恢复单项默认值。'));
  }

  var arrangementState = {sections:[
    {at:0,mode:'quiet',fade:1000},{at:30,mode:'verse',fade:1200},
    {at:60,mode:'chorus',fade:1600},{at:90,mode:'original',fade:1600}
  ],plan:null,message:''};
  function renderArrangement(body) {
    if (!window.CreativeArrangement || !window.CreativeProject) return;
    var A = CreativeArrangement, state = arrangementState;
    if (state.plan && state.plan.revision !== stage_api().revision()) {
      state.plan = null; state.message = '舞台已改变，请重新检查分段。';
    }
    var box = h('details','ws-arrangement');
    box.appendChild(h('summary',null,'按分段生成编排'));
    box.appendChild(h('p','sc-note','手动填写歌曲分段，再选择平静、叙述、增强或原始参数。示例秒数需按歌曲修改，不会自动识别前奏或副歌。检查不改变舞台。'));
    box.appendChild(h('p','sc-note','应用将替换全部 cue 并关闭自动导演，保留场景、基础参数与音频绑定。分段只用于生成，下方 cue 是保存和继续编辑的结果；需在“导出”确认媒体后执行，末段结束后保持目标值。'));
    var list = h('div'), actions = h('div','ws-row');
    var message = h('p','sc-note',state.message); message.setAttribute('role','status'); message.dataset.arrangementStatus = '';
    var preview = h('div','sc-note'); preview.dataset.arrangementPreview = '';
    var check = h('button','btn','检查分段'), apply = h('button','btn primary','替换当前编排');
    check.dataset.arrangement = 'check'; apply.dataset.arrangement = 'apply';
    function showPlan() {
      apply.disabled = !state.plan;
      preview.textContent = state.plan ? '将生成 ' + state.plan.sections.length + ' 条歌曲时间 cue，替换现有 '
        + state.plan.replacedCueCount + ' 条 cue；自动导演关闭，保留 ' + state.plan.bindingCount + ' 条音频绑定。'
        + state.plan.prepared.warnings.join(' ') : '';
    }
    function invalidate() { state.plan = null; state.message = ''; message.textContent = ''; showPlan(); }
    var add = h('button','btn','增加分段'); add.dataset.arrangement = 'add';
    function paintRows() {
      list.replaceChildren(); add.disabled = state.sections.length >= 32;
      state.sections.forEach(function (s,i) {
        var row = h('div','ws-row');
        var timeLabel = h('label',null,'开始秒数 '), at = h('input','ws-mini');
        at.type = 'number'; at.min = '0'; at.max = '86400'; at.step = '0.1'; at.value = String(s.at);
        at.setAttribute('aria-label','分段 ' + (i+1) + ' 开始秒数'); timeLabel.appendChild(at);
        var mode = h('select'); mode.setAttribute('aria-label','分段 ' + (i+1) + ' 规则');
        A.modes().forEach(function (m) { var o = h('option',null,m[1]); o.value = m[0]; mode.appendChild(o); });
        mode.value = s.mode;
        var fadeLabel = h('label',null,'过渡毫秒 '), fade = h('input','ws-mini');
        fade.type = 'number'; fade.min = '16'; fade.max = '600000'; fade.step = '100'; fade.value = String(s.fade);
        fade.setAttribute('aria-label','分段 ' + (i+1) + ' 过渡毫秒'); fadeLabel.appendChild(fade);
        at.addEventListener('input',function () { s.at = at.value === '' ? NaN : Number(at.value); invalidate(); });
        fade.addEventListener('input',function () { s.fade = fade.value === '' ? NaN : Number(fade.value); invalidate(); });
        mode.addEventListener('change',function () { s.mode = mode.value; invalidate(); });
        var remove = h('button','ws-icon','删'); remove.disabled = state.sections.length === 1;
        remove.setAttribute('aria-label','删除分段 ' + (i+1));
        remove.addEventListener('click',function () { state.sections.splice(i,1); invalidate(); paintRows(); });
        row.append(timeLabel,mode,fadeLabel,remove); list.appendChild(row);
      });
    }
    add.addEventListener('click',function () {
      if (state.sections.length >= 32) return;
      var last = state.sections[state.sections.length-1];
      state.sections.push({at:Math.min(86400,(Number.isFinite(last.at) ? last.at : 0)+30),mode:'verse',fade:1000});
      invalidate(); paintRows();
    });
    check.addEventListener('click',function () {
      try { state.plan = A.prepare(state.sections); state.message = '检查通过，请核对替换范围后应用。'; }
      catch (e) { state.plan = null; state.message = e.message; }
      message.textContent = state.message; showPlan();
    });
    apply.addEventListener('click',function () {
      var plan = state.plan; state.plan = null;
      try {
        state.message = '已生成工程 cue，可在下方继续编辑；请到“导出”确认媒体并保存工程。';
        A.apply(plan); render();
      } catch (e) { state.message = e.message; message.textContent = e.message; showPlan(); }
    });
    var project = h('button','btn','媒体确认与工程保存');
    project.addEventListener('click',function () { api.setTab('io'); });
    paintRows(); showPlan(); actions.append(add,check,apply,project);
    box.append(list,actions,preview,message); body.appendChild(box);
  }

  function renderCues(body) {
    var CS = stage_api();
    var cur = CS.preset();
    var rt = CS.runtime();

    renderArrangement(body);
    if (window.CreativePitch) CreativePitch.mount(body);

    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '编排轨'));
    head.appendChild(help('秒级 cue 填歌曲秒数；节拍 cue 填每几拍触发，目标值会按下方“缓动时长”平滑过渡。'));
    body.appendChild(head);
    body.appendChild(h('div', 'sc-note',
      '一条 cue = 在某个时刻（或每 N 拍）把一组参数缓动到目标值。'
      + '秒级 cue 跟着歌曲进度走，节拍 cue 跟着鼓点走。'));

    var addRow = h('div', 'ws-row');
    var kind = h('select', 'ws-mini');
    [['at', '歌曲时间'], ['every', '每 N 拍']].forEach(function (p) {
      var o = h('option', null, p[1]); o.value = p[0]; kind.appendChild(o);
    });
    var amount = h('input', 'ws-mini');
    amount.type = 'number';
    amount.value = '12';
    amount.min = '0';
    amount.step = '0.5';
    var len = h('input', 'ws-mini');
    len.type = 'number';
    len.value = '800';
    len.min = '50';
    len.step = '50';
    var target = pathPicker(lastParamPath || 'look.bloom', function (v) { lastParamPath = v; });
    var valueInput = h('input', 'ws-mini');
    valueInput.type = 'number';
    valueInput.step = '0.05';

    var syncRange = function () {
      var row = findRow(target.value);
      if (!row) return;
      valueInput.min = String(row[2]);
      valueInput.max = String(row[3]);
      valueInput.step = String(row[4]);
      if (valueInput.value === '') valueInput.value = String(row[6]);
    };
    target.addEventListener('change', syncRange);
    syncRange();

    var add = h('button', 'btn primary', '加一条');
    add.addEventListener('click', function () {
      var cue = { len: Number(len.value) || 600, ease: 'out', set: {} };
      if (kind.value === 'at') cue.at = Number(amount.value) || 0;
      else cue.every = Math.max(1, Math.round(Number(amount.value) || 4));
      cue.set[target.value] = Number(valueInput.value);
      if (!Number.isFinite(cue.set[target.value]) || cue.len < 16 || cue.len > 600000
        || (cue.at !== undefined && (cue.at < 0 || cue.at > 86400))
        || (cue.every !== undefined && cue.every > 4096)) { flash('请检查时间、时长与目标数值。'); return; }
      if (!CS.addCue(cue)) { flash('编排最多 64 条，请先删除一条或检查输入。'); return; }
      render();
    });
    addRow.append(kind, amount, len, target, valueInput, add);
    body.appendChild(addRow);

    if (!cur.cues.length) {
      body.appendChild(h('div', 'sc-note', '还没有 cue。没有 cue 的舞台完全由绑定和导演驱动。'));
      return;
    }
    var list = h('div', 'ws-list');
    cur.cues.forEach(function (cue, i) {
      var row = h('div', 'ws-item');
      var head = h('div', 'ws-item-head');
      head.appendChild(h('span', 'ws-tag',
        typeof cue.at === 'number' ? (num(cue.at, 1) + 's') : ('每 ' + cue.every + ' 拍')));
      var keys = Object.keys(cue.set || {});
      head.appendChild(h('span', 'ws-item-title',
        keys.length ? (findRow(keys[0]) ? findRow(keys[0])[1] : keys[0])
          + (keys.length > 1 ? ' 等 ' + keys.length + ' 项' : '')
          : '空 cue'));
      var fire = h('button', 'ws-icon', '试');
      fire.title = '立刻触发一次';
      fire.addEventListener('click', function () { CS.fire(cue); flash('已触发'); });
      var del = h('button', 'ws-icon', '删');
      del.addEventListener('click', function () { CS.removeCue(i); render(); });
      head.append(fire, del);
      row.appendChild(head);

      var detail = h('div', 'ws-item-body');
      var timeLine = h('label','ws-kv');
      timeLine.appendChild(h('span',null,typeof cue.at === 'number' ? '歌曲秒数' : '每几拍'));
      var timeInput = h('input','ws-mini'); timeInput.type = 'number';
      timeInput.min = typeof cue.at === 'number' ? '0' : '1';
      timeInput.max = typeof cue.at === 'number' ? '86400' : '4096';
      timeInput.step = typeof cue.at === 'number' ? '0.1' : '1';
      timeInput.value = String(typeof cue.at === 'number' ? cue.at : cue.every);
      timeInput.addEventListener('change',function () {
        var v = Number(timeInput.value);
        if (!Number.isFinite(v) || v < Number(timeInput.min) || v > Number(timeInput.max)) { flash('触发时间超出范围'); return; }
        if (typeof cue.at === 'number') cue.at = v; else cue.every = Math.round(v);
        CS.updateCue(i,cue);
      });
      timeLine.appendChild(timeInput); detail.appendChild(timeLine);
      detail.appendChild(select('缓动曲线',[['linear','线性'],['in','渐入'],['out','渐出'],['inout','渐入渐出']],cue.ease || 'out',function (v) {
        cue.ease = v; CS.updateCue(i,cue);
      }));
      keys.forEach(function (k) {
        var r = findRow(k);
        var line = h('div', 'ws-kv');
        line.appendChild(h('span', null, r ? r[1] : k));
        var inp = h('input', 'ws-mini');
        inp.type = 'number';
        inp.step = r ? String(r[4]) : '0.05';
        inp.value = String(cue.set[k]);
        inp.addEventListener('change', function () {
          cue.set[k] = Number(inp.value);
          CS.updateCue(i, cue);
        });
        line.appendChild(inp);
        detail.appendChild(line);
      });
      var lenLine = h('div', 'ws-kv');
      lenLine.appendChild(h('span', null, '缓动时长'));
      var lenInp = h('input', 'ws-mini');
      lenInp.type = 'number';
      lenInp.value = String(cue.len || 600);
      lenInp.addEventListener('change', function () {
        var v = Number(lenInp.value);
        if (!Number.isFinite(v) || v < 16 || v > 600000) { flash('缓动时长需为 16–600000 毫秒'); return; }
        cue.len = v;
        CS.updateCue(i, cue);
      });
      lenLine.appendChild(lenInp);
      detail.appendChild(lenLine);
      row.appendChild(detail);
      list.appendChild(row);
    });
    body.appendChild(list);

    var live = h('div', 'ws-kv ws-live');
    live.appendChild(h('span', null, '当前实时值：' + (lastParamPath || 'look.bloom')));
    live.appendChild(h('span', 'sc-value', num(rt[lastParamPath || 'look.bloom'], 2)));
    body.appendChild(live);
  }

  function renderBindings(body) {
    var CS = stage_api();
    var cur = CS.preset();
    var spec = CS.spec();

    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '音频绑定'));
    head.appendChild(help('推荐先从低频 agg.0 开始；增益可以理解成音频特征放大多少倍。'));
    body.appendChild(head);
    body.appendChild(h('div', 'sc-note',
      '绑定把音频特征按增益叠到参数上：基础值是"停下来的样子"，绑定决定它怎么动。'
      + '全部关掉就能得到一张静止的舞台照片，方便先调构图再调律动。'));

    var addRow = h('div', 'ws-row');
    var target = pathPicker('sc.height', function () {});
    var source = h('select', 'ws-mini');
    spec.binds.forEach(function (s) {
      var o = h('option', null, s); o.value = s; source.appendChild(o);
    });
    var gain = h('input', 'ws-mini');
    gain.type = 'number';
    gain.value = '2';
    gain.step = '0.1';
    var add = h('button', 'btn primary', '加一条');
    add.addEventListener('click', function () {
      var list = cur.bindings.concat([{
        target: target.value, source: source.value, gain: Number(gain.value) || 1
      }]);
      if (!CS.setBindings(list)) { flash('绑定最多 32 条，请先删除一条。'); return; }
      render();
    });
    addRow.append(target, source, gain, add);
    body.appendChild(addRow);

    if (!cur.bindings.length) {
      body.appendChild(h('div', 'sc-note', '还没有绑定。试试「agg.0 → sc.height，增益 6」看低频怎么抬柱高。'));
      return;
    }
    var list = h('div', 'ws-list');
    cur.bindings.forEach(function (b, i) {
      var row = h('div', 'ws-item');
      var head = h('div', 'ws-item-head');
      var r = findRow(b.target);
      head.appendChild(h('span', 'ws-tag', b.source));
      head.appendChild(h('span', 'ws-item-title', (r ? r[1] : b.target) + ' ← ' + b.source));
      var del = h('button', 'ws-icon', '删');
      del.addEventListener('click', function () {
        var list2 = cur.bindings.slice();
        list2.splice(i, 1);
        CS.setBindings(list2);
        render();
      });
      head.appendChild(del);
      row.appendChild(head);

      var detail = h('div', 'ws-item-body');
      var line = h('div', 'ws-kv');
      line.appendChild(h('span', null, '增益'));
      var g = h('input', 'ws-mini');
      g.type = 'number';
      g.step = '0.1';
      g.value = String(b.gain === undefined ? 1 : b.gain);
      g.addEventListener('change', function () {
        var list2 = cur.bindings.slice();
        list2[i] = { target: b.target, source: b.source, gain: Number(g.value) || 0 };
        CS.setBindings(list2);
      });
      line.appendChild(g);
      detail.appendChild(line);

      var pline = h('div', 'ws-kv');
      pline.appendChild(h('span', null, '当前贡献'));
      pline.appendChild(h('span', 'sc-value', num(b.gain === undefined ? 1 : b.gain, 2)));
      detail.appendChild(pline);
      row.appendChild(detail);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  // These are static studies of the treatment, not a second live stage.
  function lookArt(id) {
    var palettes = {
      manga: ['#e7e3d8', '#969993', '#3b4547', '#182329', '#f6f1e5'],
      anime: ['#aec6c8', '#6b9294', '#4b717d', '#243d50', '#f5dfb4'],
      pencil: ['#c6bbaa', '#a69b87', '#706e64', '#424844', '#eee5d2'],
      color: ['#c0cfc1', '#879f9c', '#4b7b7c', '#2c454e', '#e7b39f'],
      off: ['#1b2a2f', '#314951', '#466671', '#203a42', '#acc6b7']
    };
    var c = palettes[id] || palettes.off;
    var ink = id === 'manga' || id === 'pencil';
    var art = '<rect width="320" height="220" fill="' + c[0] + '"/>';
    art += '<circle cx="231" cy="62" r="29" fill="' + c[4] + '"/>';
    art += '<path d="M-12 142L55 70l46 53 68-86 57 74 32-33 76 64v88H-12Z" fill="' + c[1] + '"/>';
    art += '<path d="M169 37l-7 59 27-21 15 17Z M55 70l-6 51 29-24Z" fill="' + c[4] + '" opacity=".7"/>';
    art += '<path d="M-12 174L56 129l61 33 67-64 84 55 62-39v116H-12Z" fill="' + c[2] + '"/>';
    art += '<path d="M-10 219l94-44 78 23 58-43 110 30v45H-10Z" fill="' + c[3] + '"/>';
    art += '<path d="M-10 159Q105 207 179 141t157 22" fill="none" stroke="' + c[4] + '" stroke-width="2" opacity=".6"/>';
    if (ink) {
      art += '<g fill="none" stroke="' + c[3] + '" stroke-width="1.6"><path d="M-12 142L55 70l46 53 68-86 57 74 32-33 76 64M-12 174L56 129l61 33 67-64 84 55 62-39"/></g>';
      for (var i = 0; i < 58; i++) {
        var x = (i * 29 + 9) % 320, y = (i * 17 + 7) % 94;
        art += '<circle cx="' + x + '" cy="' + y + '" r=".85" fill="' + c[3] + '" opacity=".32"/>';
      }
      art += '<path d="M25 0L0 70M40 0L0 114M300 146l20-10M279 168l41-16" stroke="' + c[3] + '" stroke-width="1.4"/>';
    } else {
      art += '<path d="M21 48h64m-42 9h62m38-33h43" stroke="' + c[4] + '" stroke-width="3" stroke-linecap="round" opacity=".55"/>';
    }
    art += id === 'manga'
      ? '<path d="M-4 0h32L-4 87M298-4l26 0v74M-3 202l112 18" stroke="' + c[3] + '" stroke-width="8" fill="none"/>'
      : '<path d="M12 32V12h35m226 0h35v20M12 188v20h35m226 0h35v-20" stroke="' + c[4] + '" fill="none" opacity=".7"/>';
    return '<svg viewBox="0 0 320 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + art + '</svg>';
  }

  function renderLook(body) {
    var CS = stage_api();
    var cur = CS.preset();

    var intro = h('div', 'ws-look-intro');
    intro.append(h('span', 'ws-kicker', '舞台画册'), h('h2', null, '漫画与动画'),
      h('p', null, '选择一种画法，色阶、墨线与分镜一起入画。'));
    body.appendChild(intro);
    var hand = cur.hand || { on: false };
    function patchHand(values) {
      CS.setHandDrawn(Object.assign({}, CS.preset().hand || {}, values));
    }
    var styles = CS.styles();
    var selected = hand.on ? hand.style || 'manga' : 'off';
    var selectedStyle = styles.find(function (style) { return style.id === selected; }) || styles[0];
    var looks = h('div', 'ws-look-grid');
    var alternatives = h('div', 'ws-look-alternatives');
    styles.forEach(function (style) {
      var card = h('button', 'ws-look-card');
      card.type = 'button';
      card.id = 'ws-look-' + style.id;
      card.dataset.style = style.id;
      card.setAttribute('aria-pressed', String(style.id === selected));
      var swatch = h('span', 'ws-look-swatch');
      swatch.setAttribute('aria-hidden', 'true');
      swatch.innerHTML = lookArt(style.id);
      var caption = h('span', 'ws-look-caption');
      caption.append(h('strong', null, style.label), h('small', null, style.description));
      var check = h('span', 'ws-look-check');
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
      card.append(swatch, caption, check);
      card.addEventListener('click', function () {
        CS.setStyle(style.id);
        flash('已应用' + style.label);
      });
      (style.id === 'manga' || style.id === 'anime' ? looks : alternatives).appendChild(card);
    });
    body.appendChild(looks);
    body.appendChild(alternatives);
    var current = h('div', 'ws-look-current');
    current.append(h('span', null, '当前画法'), h('strong', null, selectedStyle.label));
    body.appendChild(current);
    if (hand.on) {
      var adjustment = h('details', 'ws-look-adjust');
      adjustment.appendChild(h('summary', null, '微调画面与笔触'));
      var material = h('div', 'sc-grid ws-look-material');
      [['look.toon', '色阶与描边'], ['look.paper', '网点与纸感']].forEach(function (entry) {
        var key = entry[0].split('.')[1];
        material.appendChild(slider([entry[0], entry[1], 0, 1, .02, '', selectedStyle.look ? selectedStyle.look[key] : 0], cur.look[key], function (v) { CS.setParam(entry[0], v); }));
      });
      adjustment.appendChild(material);
      var opts = h('div', 'sc-grid');
      [['frame', '分镜边框'], ['wave', '手绘声波'], ['annot', '歌词圈注'], ['paper', '边缘纸纹']].forEach(function (entry) {
        opts.appendChild(toggle(entry[1], hand[entry[0]] !== false, function (v) {
          var update = {}; update[entry[0]] = v;
          patchHand(update);
        }));
      });
      adjustment.appendChild(opts);
      var jgrid = h('div', 'sc-grid');
      jgrid.appendChild(slider(['hand.jitter', '笔触起伏', 0, 200, 5, '%', 100],
        hand.jitter === undefined ? 100 : hand.jitter, function (v) { patchHand({ jitter: v }); }));
      jgrid.appendChild(slider(['hand.speed', '笔触节奏', 25, 200, 5, '%', 100],
        hand.speed === undefined ? 100 : hand.speed, function (v) { patchHand({ speed: v }); }));
      adjustment.appendChild(jgrid);
      body.appendChild(adjustment);
    }

    body.appendChild(h('h2', 'sc-group-title', '背景来源'));
    var bg = cur.bg || { type: 'theme' };
    var types = [
      ['theme', '跟随主题'], ['mesh', '渐变网格'], ['flow', '流场'],
      ['spectrogram', '频谱色谱'], ['cover', '封面取色'], ['media', '我的图片 / 视频']
    ];
    var grid = h('div', 'ws-cards');
    types.forEach(function (t) {
      var card = h('button', 'ws-card');
      card.type = 'button';
      card.classList.toggle('on', bg.type === t[0]);
      card.appendChild(h('span', 'ws-card-name', t[1]));
      card.addEventListener('click', function () {
        var next = { type: t[0] };
        if (t[0] === 'media' && bg.type === 'media') next = Object.assign({}, bg);
        if (t[0] === 'cover') next.hue = bg.hue || 0;
        CS.setBackground(next);
        if (window.Backgrounds) Backgrounds.apply(next);
        render();
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);

    if (bg.type === 'media') {
      var fileRow = h('div', 'ws-row');
      var file = h('input');
      file.type = 'file';
      file.accept = 'image/*,video/*';
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        // 只有这个 ObjectURL 会离开浏览器内存，服务端从头到尾不知道有这张图。
        var spec2 = window.Backgrounds
          ? Backgrounds.setLocalFile(f)
          : { type: 'theme' };
        CS.setBackground(spec2);
        flash('已设为背景（' + f.name + '，' + Math.round(f.size / 1024) + ' KB）');
        render();
      });
      fileRow.appendChild(file);
      body.appendChild(fileRow);
      body.appendChild(h('div', 'sc-note',
        '图片与视频仅在本次打开期间可用。重新打开应用后，请再次选择素材。'));
    }

    // 以下控件全部走轻量路径：改参数不拆 DOM、不重起视频/生成画布。
    // 显示与写回都以 Backgrounds 归一化后的值为准（CS 里可能存着旧版 spec）。
    if (bg.type !== 'theme' && window.Backgrounds) {
      var defFx = Backgrounds.defaults(bg.type);
      var patch = function (mut) {
        var spec = Backgrounds.values();
        mut(spec);
        var norm = Backgrounds.update(spec);   // 同类型：只刷变量与空间模式
        CS.setBackground(norm);
        return norm;
      };

      if (bg.type === 'cover' || bg.type === 'mesh') {
        var hueCell = h('div', 'sc-cell');
        var hlab = h('label', 'sc-label');
        hlab.append(h('span', null, '色相偏移'), h('span', 'sc-value', num(bg.hue || 0, 0) + '°'));
        hueCell.appendChild(hlab);
        var hue = h('input');
        hue.type = 'range'; hue.min = '0'; hue.max = '360'; hue.step = '5';
        hue.value = String(bg.hue || 0);
        hue.addEventListener('input', function () {
          hlab.lastChild.textContent = hue.value + '°';
          patch(function (s) { s.hue = Number(hue.value); });
        });
        hueCell.appendChild(hue);
        body.appendChild(hueCell);
      }

      var fv = Backgrounds.values();
      body.appendChild(h('h2', 'sc-group-title', '融合与空间'));
      var fxgrid = h('div', 'sc-grid');
      fxgrid.appendChild(slider(['bg.opacity', '不透明度', 0, 100, 1, '%', defFx.opacity],
        fv.opacity, function (v) { patch(function (s) { s.opacity = v; }); }));
      fxgrid.appendChild(slider(['bg.blur', '模糊', 0, 60, 1, 'px', defFx.blur],
        fv.blur, function (v) { patch(function (s) { s.blur = v; }); }));
      body.appendChild(fxgrid);

      var modegrid = h('div', 'sc-grid');
      modegrid.appendChild(select('融合方式', [
        ['normal', '正常'], ['screen', '滤色'], ['overlay', '叠加'],
        ['soft-light', '柔光'], ['lighten', '变亮']
      ], fv.blend, function (v) { patch(function (s) { s.blend = v; }); }));
      modegrid.appendChild(select('空间模式', [
        ['flat', '平面'],
        ['parallax', '视差（跟随指针）'],
        ['scene', '弧形墙']
      ], fv.depthMode, function (v) {
        patch(function (s) { s.depthMode = v; });
        render();   // 切换空间模式要刷出"生效真相"提示
      }));
      body.appendChild(modegrid);

      var st = Backgrounds.stats();
      if (st.depthMode === 'scene' && st.depthEffective !== 'scene') {
        // 生效真相：用户选了弧形墙但设备给不了，必须明说而不是假装在跑
        body.appendChild(h('div', 'sc-note ws-warn',
          '这台设备不支持 WebGL2（或图形上下文已丢失），弧形墙没有运行；'
          + '实际生效的是「视差」模式，移动鼠标即可看到跟随。'));
      } else if (st.depthEffective === 'scene') {
        body.appendChild(h('div', 'sc-note',
          '弧形墙运行中，移动指针环顾；墙内亮度随音乐能量起伏。'));
      }
    }
  }

  function renderShareCode(body, CS) {
    body.appendChild(h('h2', 'sc-group-title', '分享创意预置'));
    body.appendChild(h('p', 'sc-note', '分享名称、场景参数、编排、绑定与背景／手绘设置。'
      + '不包含沉浸舞台设置、媒体文件、文件地址或账户信息；媒体背景会改为跟随主题。'));
    var label = h('label', 'sc-note', '分享码'); label.htmlFor = 'ws-share-code'; body.appendChild(label);
    var code = h('textarea', 'ws-json'); code.id = 'ws-share-code'; code.spellcheck = false;
    code.placeholder = '粘贴收到的分享码，或生成当前预置的分享码'; code.maxLength = 180000;
    body.appendChild(code);
    var compatibility = h('label', 'ws-row');
    var plain = h('input'); plain.type = 'checkbox'; plain.id = 'ws-share-compatible';
    compatibility.append(plain, h('span', null, '兼容码（不压缩，适合不支持解压的设备）'));
    body.appendChild(compatibility);
    var row = h('div', 'ws-row'), status = h('p', 'sc-note');
    status.id = 'ws-share-status'; status.setAttribute('role', 'status');
    var serial = 0, view = shareViewRevision;
    function ticket() {
      var sequence = ++serial, revision = shareEditRevision;
      return function () {
        return sequence === serial && view === shareViewRevision && revision === shareEditRevision
          && isOpen() && target === 'advanced' && tab === 'io' && code.isConnected;
      };
    }
    code.addEventListener('input', function () { serial += 1; status.textContent = ''; });
    plain.addEventListener('change', function () { serial += 1; });
    async function copyCode(alive) {
      code.focus(); code.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { /* try the available host channel */ }
      if (!copied) {
        try {
          if (window.hertzHost && window.hertzHost.isDbx && window.dbxPlugin) await window.dbxPlugin.copy(code.value);
          else if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(code.value);
          else throw new Error('clipboard unavailable');
          copied = true;
        } catch (e) { /* selected text remains available for manual copy */ }
      }
      if (alive()) status.textContent = copied ? '分享码已复制' : '自动复制失败，文本已选中；请按 Ctrl+C 或手动复制';
    }
    var generate = h('button', 'btn', '生成并复制分享码'); generate.id = 'ws-share-copy';
    generate.addEventListener('click', async function () {
      var alive = ticket(); status.textContent = '正在生成分享码…';
      try {
        if (!window.CreativeShareCode) throw new Error('分享码模块尚未就绪，请刷新应用');
        var encoded = await CreativeShareCode.encode(CS.shareSnapshot(), { compress: !plain.checked });
        if (!alive()) return;
        code.value = encoded;
        await copyCode(alive);
      } catch (e) { if (alive()) status.textContent = e.message || String(e); }
    });
    var load = h('button', 'btn primary', '载入分享码'); load.id = 'ws-share-import';
    load.addEventListener('click', async function () {
      var alive = ticket(); status.textContent = '正在读取分享码…';
      try {
        if (!window.CreativeShareCode) throw new Error('分享码模块尚未就绪，请刷新应用');
        var decoded = await CreativeShareCode.decode(code.value);
        if (!alive()) return;
        CS.setPreset(decoded);
        flash('已载入「' + decoded.name + '」');
      } catch (e) { if (alive()) status.textContent = e.message || String(e); }
    });
    row.append(generate, load); body.append(row, status);
  }

  var projectState = {text:'',prepared:null,revision:0,message:''};
  function renderProject(body) {
    if (!window.CreativeProject) return;
    var P = CreativeProject, CS = stage_api();
    body.appendChild(h('h2','sc-group-title','可编辑工程'));
    body.appendChild(h('div','sc-note','工程保存完整参数、cue 轨和可选的媒体内容身份，不包含音乐文件或自定义图片/视频。在线曲目需先完成缓存；远程文件需允许完整读取。cue 轨需确认媒体后才执行，换曲或刷新后须重新确认。'));
    var remoteRead = h('input'); remoteRead.type = 'checkbox'; remoteRead.dataset.project = 'remote-read';
    var remoteLabel = h('label','sc-note');
    remoteLabel.append(remoteRead,document.createTextNode('允许读取远程完整音频以核对内容（最多 2 GiB / 10 秒，可能消耗流量）'));
    body.appendChild(remoteLabel);
    var status = h('p','sc-note',P.status()); status.dataset.projectStatus = '';
    body.appendChild(status);
    var ta = h('textarea','ws-json'); ta.id = 'ws-project-json'; ta.setAttribute('aria-label','舞台工程 JSON');
    ta.spellcheck = false; ta.value = projectState.text;
    var message = h('p','sc-note',projectState.message); message.setAttribute('role','status');
    var row = h('div','ws-row');
    var check = h('button','btn','检查工程'), apply = h('button','btn primary','应用已检查工程');
    check.dataset.project = 'check'; apply.dataset.project = 'apply'; apply.disabled = !projectState.prepared;
    function valid() { return check.isConnected && isOpen() && target === 'advanced' && tab === 'io' && !document.hidden; }
    function say(text) { projectState.message = text; message.textContent = text; }
    ta.addEventListener('input',function () { projectState.text = ta.value; projectState.prepared = null; apply.disabled = true; say(''); });
    check.addEventListener('click',function () {
      try {
        projectState.prepared = P.prepare(ta.value); projectState.revision = CS.revision();
        apply.disabled = false;
        var p = projectState.prepared;
        say('检查通过：' + p.project.preset.scene + ' · ' + p.project.preset.cues.length + ' 条 cue。'
          + (p.project.media ? '包含媒体内容身份。' : '未绑定媒体。') + p.warnings.join(' '));
      } catch (e) { projectState.prepared = null; apply.disabled = true; say(e.message); }
    });
    apply.addEventListener('click',function () {
      try {
        var prepared = projectState.prepared;
        projectState.prepared = null;
        projectState.message = '工程已应用，参数与编排可继续编辑；请确认绑定当前曲目后执行 cue。';
        P.apply(prepared,projectState.revision);
        render();
      } catch (e) { say(e.message); }
    });
    var bind = h('button','btn','确认绑定当前曲目'); bind.dataset.project = 'bind';
    bind.addEventListener('click',async function () {
      bind.disabled = true; say('正在核对完整媒体内容…');
      try { await P.bindCurrent(valid,remoteRead.checked); if (valid()) { status.textContent = P.status(); say('媒体内容已确认；本次曲目 cue 轨已启用。'); } }
      catch (e) { if (valid()) { status.textContent = P.status(); say(e.message); } }
      finally { if (valid()) bind.disabled = false; }
    });
    row.append(check,apply,bind);
    var file = h('input'); file.type = 'file'; file.accept = '.json,.hertz-stage,application/json'; file.setAttribute('aria-label','打开舞台工程文件');
    file.addEventListener('change',async function () {
      var selected = file.files && file.files[0]; if (!selected) return;
      if (selected.size > 256 * 1024) { say('工程超过 256 KiB'); return; }
      try { var text = await selected.text(); if (valid() && file.files[0] === selected) { ta.value = text; ta.dispatchEvent(new Event('input')); say('文件已读取，请检查后应用。'); } }
      catch (_) { if (valid()) say('无法读取工程文件'); }
    });
    var exportRow = h('div','ws-row');
    var include = h('input'); include.type = 'checkbox'; include.checked = true;
    var label = h('label'); label.append(include,document.createTextNode('包含当前曲目内容指纹'));
    var save = h('button','btn','下载可编辑工程'); save.dataset.project = 'save';
    save.addEventListener('click',async function () {
      save.disabled = true; say('正在生成工程…');
      try {
        var prepared = await P.capture(include.checked,valid,remoteRead.checked);
        if (!valid()) return;
        var text = JSON.stringify(prepared.project,null,2), blob = new Blob([text],{type:'application/json'});
        var url = URL.createObjectURL(blob), a = h('a');
        a.href = url; a.download = (prepared.project.preset.name || 'stage').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80) + '.hertz-stage.json';
        try { document.body.appendChild(a); a.click(); }
        finally { a.remove(); setTimeout(function () { URL.revokeObjectURL(url); },30000); }
        say('工程下载已发起，请确认保存。' + prepared.warnings.join(' '));
      } catch (e) { if (valid()) say(e.message); }
      finally { if (valid()) save.disabled = false; }
    });
    exportRow.append(label,save); body.append(exportRow,file,ta,row,message);
  }

  document.addEventListener('stage:track-changed',function () {
    if (!refs.body || !window.CreativeProject) return;
    var status = refs.body.querySelector('[data-project-status]');
    if (status) status.textContent = CreativeProject.status();
  });

  function renderIO(body) {
    var CS = stage_api();
    body.appendChild(h('p','sc-note','草稿是待确认的候选；分享码携带完整预置并在载入时立即应用；工程另含时间线版本与媒体身份；视频是成片。收藏只由“存进工坊”另存，预览不会替换已保存内容。'));
    renderProject(body);
    renderDraftImport(body);
    renderShareCode(body, CS);
    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '导出 / 导入'));
    head.appendChild(help('先复制或下载 JSON；把别人的 JSON 粘贴到文本框后点“载入这段 JSON”。'));
    body.appendChild(head);
    body.appendChild(h('div', 'sc-note',
      '一份预置就是一段 JSON：场景、全部参数、cue 轨、绑定、背景与手绘设置。'
      + '它是普通预置；媒体绑定请使用上方工程文件，外部素材与跨设备画面需另行确认。'));

    var ta = h('textarea', 'ws-json');
    ta.spellcheck = false;
    ta.value = CS.exportJSON();
    body.appendChild(ta);

    var row = h('div', 'ws-row');
    var copy = h('button', 'btn', '复制');
    copy.addEventListener('click', function () {
      ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      // 插件 iframe 是 opaque origin，execCommand 与 navigator.clipboard 都不可用，
      // 只能走宿主的 copy 通道。独立形态下前两条路照旧。
      if (!done && window.hertzHost && window.hertzHost.isDbx && window.dbxPlugin) {
        window.dbxPlugin.copy(ta.value).then(function () { flash('已复制'); },
          function () { flash('复制失败，请手动选中'); });
        return;
      }
      if (!done && navigator.clipboard) {
        navigator.clipboard.writeText(ta.value).then(function () { flash('已复制'); },
          function () { flash('复制失败，请手动选中'); });
        return;
      }
      flash(done ? '已复制' : '复制失败，请手动选中');
    });
    var dl = h('button', 'btn', '下载 .json');
    dl.addEventListener('click', function () {
      var blob = new Blob([ta.value], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (CS.preset().name || 'stage') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    });
    var imp = h('button', 'btn primary', '载入这段 JSON');
    imp.addEventListener('click', function () {
      var r = CS.importJSON(ta.value);
      flash(r.message);
      if (r.ok) render();
    });
    var snap = h('button', 'btn', '抓一张缩略图');
    snap.addEventListener('click', function () {
      var url = CS.capture();
      flash(url ? '已抓取当前帧，保存预置时会一起存下' : '当前画布拿不到像素');
    });
    row.append(copy, dl, imp, snap);
    body.appendChild(row);

    var st = CS.stats();
    body.appendChild(h('h2', 'sc-group-title', '运行状态'));
    var info = h('div', 'ws-stats');
    function kv(k, v) {
      var line = h('div', 'ws-kv');
      line.appendChild(h('span', null, k));
      line.appendChild(h('span', 'sc-value', v));
      info.appendChild(line);
    }
    [
      ['渲染', st.active ? '三维舞台' : '未启用'],
      ['场景', st.scene],
      ['段落', st.section],
      ['目标帧率', st.fps + ' fps'],
      ['设备档', st.tier],
      ['起音', st.beats + ' 次'],
      ['活动动画', st.animations],
      ['cue / 绑定', st.cueCount + ' / ' + st.bindCount]
    ].forEach(function (pair) {
      kv(pair[0], String(pair[1]));
    });
    // 代价探测的结论：它会自己把渲染分辨率往下让，用户没碰过这个旋钮，
    // 所以必须在这里说清楚让了几档、实测代价是多少 —— 否则症状只是"画面变糊了"。
    var pr = st.probe;
    if (pr && (pr.step > 0 || pr.loss !== null)) {
      kv('渲染分辨率', '×' + pr.dprScale
        + (pr.loss === null ? '（测量中）'
          : ' · 实测代价 ' + Math.round(pr.loss * 100) + '%（' + pr.base + '→' + pr.on + 'fps）'));
    }
    body.appendChild(info);
    if (window.Backgrounds) {
      var bs = Backgrounds.stats();
      kv('背景', bs.type + ' · ' + bs.fps + 'fps');
    }
  }

  // -------------------------------------------------------------------------
  // 骨架
  // -------------------------------------------------------------------------

  var SCENE_DESCRIPTIONS = {
    towers: '频谱化作光柱，节拍延伸成纵深', orb: '球面随频段呼吸，微光围绕流转',
    tunnel: '穿行光环，用镜头编排速度', nebula: '星尘缓缓聚散，光随声音展开',
    terrain: '声音塑造起伏，镜头掠过山脊', lyric: '让歌词成为空间中的光与文字'
  };

  // Static scene studies are navigational thumbnails; the large stage renders
  // the actual scene with current music and creative settings.
  function sceneArt(id) {
    var art = '<rect width="320" height="180" fill="#0e191b"/>', shape = '';
    for (var i = 0; i < 75; i++) {
      var x = (i * 73 + 17) % 320, y = (i * 37 + 11) % 180;
      shape += '<circle cx="' + x + '" cy="' + y + '" r=".7" opacity=".3"/>';
    }
    if (id === 'resonance' || id === 'tunnel') {
      for (i = 0; i < 11; i++) shape += '<ellipse cx="160" cy="90" rx="' + (id === 'tunnel' ? 12 + i * 13 : 84 + i * 2) + '" ry="' + (id === 'tunnel' ? 8 + i * 8 : 24 + i * 2) + '" transform="rotate(-23 160 90)" fill="none" stroke="currentColor" opacity="' + (.16 + i * .045) + '"/>';
    } else if (id === 'orb') {
      for (i = 0; i < 14; i++) shape += '<ellipse cx="160" cy="90" rx="62" ry="' + (4 + i * 4.3) + '" fill="none" stroke="currentColor" opacity=".55"/>';
    } else if (id === 'towers') {
      for (i = 0; i < 17; i++) {
        var height = 25 + Math.sin(i * .78) * 23 + (i % 4) * 13;
        shape += '<path d="M' + (24 + i * 16) + ' 148v-' + height.toFixed(1) + 'h7v' + height.toFixed(1) + '" fill="none" stroke="currentColor" opacity=".65"/>';
      }
    } else if (id === 'lyric') {
      for (i = 0; i < 7; i++) shape += '<path d="M' + (60 + i * 16) + ' ' + (42 + i * 14) + 'h' + (190 - i * 17) + '" stroke="currentColor" stroke-width="' + (1 + i * .7) + '" opacity="' + (.2 + i * .08) + '"/>';
    } else if (id === 'silk') {
      for (i = 0; i < 21; i++) shape += '<path d="M' + (98 + i * 6) + ' 38q-25 52 0 104" fill="none" stroke="currentColor" opacity=".65"/>';
    } else if (id === 'terrain') {
      for (i = 0; i < 13; i++) shape += '<path d="M0 ' + (65+i*7) + ' Q65 ' + (i*5) + ' 110 ' + (75+i*6) + 'T230 ' + (60+i*6) + 'T320 ' + (80+i*6) + '" fill="none" stroke="currentColor" opacity=".45"/>';
    } else {
      for (i = 0; i < 13; i++) shape += '<path d="M-20 ' + (80+i*4) + 'Q85 ' + (-30+i*8) + ' 155 85T350 ' + (70+i*5) + '" fill="none" stroke="currentColor" opacity=".38" transform="rotate(' + (id === 'prism' ? i*12 : -12) + ' 160 90)"/>';
    }
    return '<svg class="ws-scene-art" viewBox="0 0 320 180" aria-hidden="true">' + art + '<g fill="currentColor">' + shape + '</g></svg>';
  }

  function snapshot() { return window.Stage3D.preferences(); }
  function remember(previous) {
    if (JSON.stringify(previous) === JSON.stringify(snapshot())) return;
    past.push(previous); if (past.length > 40) past.shift(); future = [];
    syncHistory();
  }
  function edit(values) {
    var previous = snapshot(); Stage3D.configure(values); remember(previous); Stage3D.save(); render();
  }
  async function restoreDefaults() {
    if (resetting) return;
    resetting = true;
    refs.defaults.disabled = true;
    refs.defaults.setAttribute('aria-busy', 'true');
    // The old history only contains immersive preferences. Keeping it would
    // bring back half a creative composition after a complete reset.
    past = []; future = []; gesture = null;
    target = 'immersive'; tab = 'scene';
    render();
    refs.body.inert = true;
    refs.targets.inert = true;
    $('ws-tabs').inert = true;
    flash('正在恢复并保存舞台设置…');
    try {
      await Stage3D.resetSettings();
      flash('已恢复舞台默认，已保存的工坊作品仍保留');
    } catch (e) {
      flash('画面已恢复默认，设置暂未保存，请重试');
    } finally {
      var focused = document.activeElement;
      var returnToReset = isOpen() && (focused === document.body || focused === refs.defaults);
      resetting = false;
      refs.defaults.disabled = false;
      refs.defaults.removeAttribute('aria-busy');
      refs.body.inert = false;
      refs.targets.inert = false;
      $('ws-tabs').inert = false;
      render();
      if (returnToReset) refs.defaults.focus({ preventScroll: true });
    }
  }
  function syncHistory() {
    if ($('ws-undo')) $('ws-undo').disabled = !past.length;
    if ($('ws-redo')) $('ws-redo').disabled = !future.length;
  }
  function travel(undo) {
    var from = undo ? past : future, to = undo ? future : past;
    if (!from.length) return;
    to.push(snapshot()); Stage3D.configure(from.pop()); Stage3D.save(); render();
  }
  function immersiveSlider(row, prefs) {
    var cell = slider(row, prefs[row[0]], function (value) {
      if (!gesture) gesture = snapshot();
      var change = {}; change[row[0]] = value; Stage3D.configure(change);
    });
    cell.addEventListener('change', function () {
      if (gesture) { remember(gesture); gesture = null; } Stage3D.save();
    });
    return cell;
  }
  // 商籁 / 凝彩（以及流光 / 心象）接管画面时，舞台参数已经不作用于画面了。
  //
  // 它们的渲染器是各自独立的（商籁/凝彩走 Pixi，流光/心象走 DOM+CSS），舞台
  // 那一套相机/律动/光晕根本不在渲染路径上。此时让用户继续拖滑块，改动既不会
  // 被看见、也不会真的作用在舞台上 —— 那是骗人，比不给调更糟。所以沉浸舞台
  // 下只保留「选择」（选声场、选歌词视觉、选主题），把参数编辑整段关掉。
  //
  // 判据读 Stage3D.visualState().effective 而不是 preferences().stanzaVisual：
  // starborn 是元导演，它自己不当渲染器，真正生效的是 director 当前指向的那个。
  function stanzaVisual() {
    if (!window.Stage3D || !Stage3D.visualState) return null;
    var vs = Stage3D.visualState();
    if (!vs || !vs.active) return null;
    return vs.effective;
  }

  // 上一次渲染时的锁定值。只在它翻转时才重渲染（见 init 里 onVisualChange）。
  var lastLock = null;

  var STANZA_LABELS = {
    classic: '流光歌词', cadenza: '心象歌词', sonnet: '商籁歌词', tempera: '凝彩歌词'
  };

  // 锁定时顶上那条说明。要说清三件事：谁接管了、为什么调不动、怎么回去。
  // 只写"已锁定"等于让用户自己猜，猜不到就会以为面板坏了。
  function stanzaNotice(vs) {
    var label = STANZA_LABELS[vs] || '歌词视觉';
    var box = h('div', 'ws-stanza-note');
    box.id = 'ws-stanza-note';
    box.append(
      h('strong', null, label + '正在接管画面'),
      h('p', null, '这一套视觉有自己的排版与光影，舞台的机位、光晕与背景参数不再作用于画面，' +
        '所以这里只保留选择。例外是「镜头动态」与「律动强度」：它们通过歌词层的缓慢运镜与起音冲击 ' +
        '仍然进得到画面。想调回整套舞台参数，把「歌词视觉」切回「舞台 3D 歌词轨」。')
    );
    return box;
  }

  function renderImmersive(body) {
    var prefs = snapshot();
    var vs = stanzaVisual();
    var locked = !!vs;
    lastLock = vs || null;
    var intro = h('div', 'ws-intro');
    intro.append(h('span', 'ws-kicker', 'THE LISTENING ROOM'), h('h2', null, '给音乐一个空间'), h('p', null, '挑选声场，调整光与节奏。每一次改变，即刻呈现在大舞台。'));
    body.appendChild(intro);
    if (prefs.sceneSource === 'creative') body.appendChild(h('p', 'sc-note', '大舞台正在演出高级编排。选择下方声场或心情模板，即可切换为沉浸声场。'));
    if (locked) body.appendChild(stanzaNotice(vs));
    var history = h('div', 'ws-history');
    [['ws-undo', '撤销', function () { travel(true); }], ['ws-redo', '重做', function () { travel(false); }]].forEach(function (spec) {
      var b = h('button', 'btn', spec[1]); b.type = 'button'; b.id = spec[0]; b.addEventListener('click', spec[2]); history.appendChild(b);
    });
    // Undo/redo edit immersive parameters; the global reset remains available.
    if (locked) history.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    body.appendChild(history);
    body.appendChild(h('h3', 'ws-section-title', '从一种心情开始'));
    var templates = h('div', 'ws-templates');
    [
      ['夜航', '缓慢穿行，光随声动', { scene: 'tunnel', motion: .3, bloom: .65, reactivity: 1, layout: 'focus' }],
      ['静听', '把注意力留给每一句', { scene: 'aurora', motion: .15, bloom: .4, reactivity: .55, layout: 'focus' }],
      ['声浪', '星环共振，节拍鲜明', { scene: 'resonance', motion: .65, bloom: .9, reactivity: 1.65, layout: 'focus' }],
      ['封面时刻', '像翻开一张珍藏唱片', { scene: 'silk', motion: .2, bloom: .55, reactivity: .85, layout: 'sleeve' }]
    ].forEach(function (spec, index) {
      var b = h('button', 'ws-template'); b.type = 'button'; b.id = 'ws-template-' + index; b.innerHTML = sceneArt(spec[2].scene);
      var label = h('span'); label.append(h('strong', null, spec[0]), h('small', null, spec[1])); b.appendChild(label);
      // 模板是一整套舞台参数的预设，锁定时同样不作用：留着能点就等于骗人。
      if (locked) b.disabled = true;
      b.addEventListener('click', function () { edit(Object.assign(Stage3D.defaults(), spec[2])); }); templates.appendChild(b);
    });
    body.appendChild(templates);
    body.appendChild(h('h3', 'ws-section-title', '选择声场'));
    // 声场卡保持可用：这是"现场的创意舞台被选择"的那部分，与 stanza 无关。
    // 选了它仍然写进偏好，stanza 关掉的瞬间就按新声场呈现。
    var scenes = h('div', 'ws-scene-grid');
    Stage3D.stages().forEach(function (scene) {
      var b = h('button', 'ws-scene-card'); b.type = 'button'; b.dataset.scene = scene.id; b.id = 'ws-scene-' + scene.id;
      b.setAttribute('aria-pressed', String(scene.id === prefs.scene)); b.innerHTML = sceneArt(scene.id);
      b.append(h('strong', null, scene.label), h('small', null, scene.desc));
      b.addEventListener('click', function () { edit({ scene: scene.id, sceneSource: 'immersive' }); }); scenes.appendChild(b);
    });
    body.appendChild(scenes);
    body.appendChild(locked
      ? h('h3', 'ws-section-title is-locked', '光与节奏 · 由歌词视觉接管')
      : h('h3', 'ws-section-title', '光与节奏'));
    var controls = h('div', 'ws-tuning');
    [ ['reactivity', '律动强度', 0, 2, .05, '', 1.35], ['motion', '镜头动态', 0, 1, .05, '', .65], ['bloom', '光晕强度', 0, 1.5, .05, '', .8] ].forEach(function (row) { controls.appendChild(immersiveSlider(row, prefs)); });
    controls.appendChild(toggle('镜头自动巡航', prefs.cruise, function (v) { edit({ cruise: v }); }));
    controls.querySelector('[role="switch"]').id = 'ws-cruise';
    // 歌词字号/字间柔光归 stanza 自己管（它有自己的排版与光学后期），
    // 舞台侧的同名参数在 stanza 激活时是死设置，同样关掉。
    if (locked) controls.querySelectorAll('input, [role="switch"]').forEach(function (el) { el.disabled = true; });
    body.appendChild(controls);
    body.appendChild(h('h3', 'ws-section-title', '封面与歌词'));
    var reading = h('div', 'ws-tuning');
    reading.appendChild(select('聆听布局', [['focus', '沉浸歌词'], ['sleeve', '封面与歌词'], ['single', '简洁单句']], prefs.layout, function (v) { edit({ layout: v }); }));
    reading.appendChild(select('歌词视觉', [['stage', '舞台 3D 歌词轨'], ['classic', '流光歌词'], ['cadenza', '心象歌词'], ['sonnet', '商籁歌词'], ['tempera', '凝彩歌词']], prefs.stanzaVisual || 'stage', function (v) { edit({ stanzaVisual: v }); }));
    reading.appendChild(select('舞台主题', [['classic', '默认'], ['starfall', '星落']], prefs.stageTheme || 'classic', function (v) { edit({ stageTheme: v }); }));
    reading.appendChild(toggle('显示歌词', prefs.lyrics, function (v) { edit({ lyrics: v }); }));
    reading.querySelector('select').id = 'ws-layout';
    reading.querySelector('label').htmlFor = 'ws-layout';
    reading.querySelector('[role="switch"]').id = 'ws-lyrics';
    reading.appendChild(immersiveSlider(['lyricSize', '歌词字号', .75, 1.35, .05, '×', 1], prefs));
    reading.appendChild(immersiveSlider(['lyricGlow', '字间柔光', 0, 1, .05, '', .45], prefs));
    // 上面这两个滑块在 stanza 激活时是死设置（stanza 有自己的排版与光学后期），
    // 但「歌词视觉」下拉必须留着 —— 那是回到可编辑状态的唯一出口。
    if (locked) {
      var lyricSliders = reading.querySelectorAll('.ws-slider input, input[type="range"]');
      lyricSliders.forEach(function (el) { el.disabled = true; });
    }
    body.appendChild(reading);
    body.appendChild(h('p', 'ws-save-note', locked
      ? '选择自动保存 · 舞台参数已由歌词视觉接管'
      : '设置自动保存 · 关闭工坊，继续沉浸聆听'));
    syncHistory();
  }

  function switchTarget(next) {
    if (target === next) return;
    target = next;
    if (target === 'advanced') activateCreativeStage();
    render();
  }

  function activateCreativeStage() {
    if (!window.Stage3D) return;
    if (Stage3D.preferences().sceneSource !== 'creative') {
      Stage3D.configure({ sceneSource: 'creative' });
      Stage3D.save();
    }
    if (!Stage3D.isActive()) Stage3D.open();
  }

  function syncStageStatus() {
    var status = $('ws-stage-status');
    if (!status) return;
    status.hidden = target !== 'advanced';
    if (status.hidden || !isOpen()) return;
    var CS = stage_api();
    var reason = CS && CS.degradedBecause && CS.degradedBecause();
    var active = window.Stage3D && Stage3D.isActive() && Stage3D.preferences().sceneSource === 'creative';
    var playing = document.body.classList.contains('is-playing');
    status.classList.toggle('is-unavailable', !!reason || !active);
    status.querySelector('strong').textContent = reason ? '创意舞台暂不可用' : active ? '正在编辑大舞台' : '大舞台尚未开启';
    status.querySelector('span').textContent = reason
      ? '图形渲染未就绪，设置已保留。'
      : active ? (playing ? '随当前音乐演出 · 设置自动保存' : '音乐已暂停 · 播放后继续编排') : '设置已保留，打开大舞台后生效。';
  }

  var TABS = [
    ['prompt', '一句成景'], ['ai', 'AI 生成'], ['ledger', '费用账本'], ['scene', '场景'], ['presets', '收藏'], ['params', '参数'],
    ['cues', '编排'], ['binds', '绑定'], ['look', '电影风格'], ['io', '导出']
  ];

  function revealTab() {
    if (target === 'advanced' && isOpen() && refs.tabs && refs.tabs[tab]) {
      refs.tabs[tab].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function render() {
    if (!refs.body) return;
    clearAiCredential();
    if (window.CreativePitch) CreativePitch.unmount();
    if (window.AiLedger && (target !== 'advanced' || tab !== 'ledger' || !isOpen())) AiLedger.unmount();
    if (!aiVisible() && aiTimer) { clearInterval(aiTimer); aiTimer = 0; }
    releaseSceneArt();
    shareViewRevision += 1;
    var page = target + ':' + tab;
    var samePage = renderedPage === page;
    if (!samePage) discardDraft();
    if (isAiDraftSource(draftState.source) && aiState.proposal
      && aiState.proposal.proposalId === draftState.source && aiState.proposal.state !== 'pending') discardDraft();
    var scroll = samePage ? refs.body.scrollTop : 0;
    var focused = document.activeElement;
    var focusId = samePage && refs.body.contains(focused) && focused.id;
    renderedPage = page;
    refs.panel.dataset.target = target;
    refs.targets.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.target === target)); });
    $('ws-tabs').hidden = target !== 'advanced';
    syncStageStatus();
    refs.body.textContent = '';
    if (target === 'immersive') {
      renderImmersive(refs.body); refs.body.scrollTop = scroll;
      if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
      return;
    }
    TABS.forEach(function (t) {
      if (refs.tabs && refs.tabs[t[0]]) refs.tabs[t[0]].classList.toggle('on', tab === t[0]);
    });
    revealTab();
    if (tab !== 'ai' && aiTimer) { clearInterval(aiTimer); aiTimer = 0; }
    if (tab === 'prompt') renderPrompt(refs.body);
    else if (tab === 'ai') renderAi(refs.body);
    else if (tab === 'ledger' && window.AiLedger) AiLedger.mount(refs.body, window.VMusicTransport);
    else if (tab === 'scene') renderScene(refs.body);
    else if (tab === 'presets') renderPresets(refs.body);
    else if (tab === 'params') renderParams(refs.body);
    else if (tab === 'cues') renderCues(refs.body);
    else if (tab === 'binds') renderBindings(refs.body);
    else if (tab === 'look') renderLook(refs.body);
    else renderIO(refs.body);
    refs.body.scrollTop = scroll;
    observeSceneArt();
    if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
  }

  var flashTimer = 0;
  function flash(msg) {
    if (!refs.toast) return;
    refs.toast.textContent = msg;
    refs.toast.hidden = false;
    refs.toast.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      refs.toast.classList.remove('show');
      setTimeout(function () { refs.toast.hidden = true; }, 220);
    }, 2200);
  }

  function setOpen(next) {
    var panel = refs.panel;
    if (!panel) return false;
    if (next === isOpen()) return next;
    if (!next) clearAiCredential();
    if (!next && aiTimer) { clearInterval(aiTimer); aiTimer = 0; }
    if (!next && window.AiLedger) AiLedger.unmount();
    if (!next && window.CreativePitch) CreativePitch.unmount();
    shareViewRevision += 1;
    if (next) {
      returnFocus = document.activeElement;
      if (target === 'advanced') activateCreativeStage();
      else if (window.Stage3D && !Stage3D.isActive()) Stage3D.open();
      // 舞台层开着（无论当前目标是沉浸还是高级）：面板都挂进舞台层浮在其上，
      // 否则高级编排的面板会被舞台层整个盖住，什么都看不见。
      if (window.Stage3D && Stage3D.isActive()) {
        $('stage3d').appendChild(panel);
        $('stage3d').classList.add('s3d-editing', 's3d-chrome');
      }
      panel.inert = false;
    } else {
      discardDraft();
      releaseSceneArt();
      if (gesture) { remember(gesture); gesture = null; Stage3D.save(); }
      $('stage3d').classList.remove('s3d-editing');
      if (home) home.after(panel);
    }
    panel.hidden = !next;
    void panel.offsetWidth;                 // hidden → is-open 同帧合并会吃掉过渡
    panel.classList.toggle('is-open', next);
    panel.setAttribute('aria-hidden', String(!next));
    document.body.classList.toggle('ws-open', next);
    var btn = $('workshop-btn');
    if (btn) {
      btn.classList.toggle('active', next);
      btn.setAttribute('aria-expanded', String(next));
    }
    if (next) { render(); $('ws-close').focus({ preventScroll: true }); }
    else if (returnFocus && returnFocus.isConnected && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true });
    return next;
  }

  function isOpen() {
    return !!(refs.panel && refs.panel.classList.contains('is-open'));
  }

  function init() {
    refs.panel = $('workshop');
    refs.body = $('ws-body');
    refs.toast = $('ws-toast');
    if (!refs.panel || !refs.body) return null;
    home = document.createComment('workshop home'); refs.panel.before(home);
    refs.targets = h('div', 'ws-targets'); refs.targets.setAttribute('aria-label', '编辑目标');
    [['immersive', '沉浸声场'], ['advanced', '高级编排']].forEach(function (spec) {
      var b = h('button', null, spec[1]); b.type = 'button'; b.dataset.target = spec[0];
      b.addEventListener('click', function () { switchTarget(spec[0]); }); refs.targets.appendChild(b);
    });
    $('ws-tabs').before(refs.targets);
    refs.panel.querySelector('.ws-sub').textContent = '你的声音，你的舞台';
    refs.defaults = h('button', 'ws-defaults', '恢复舞台默认');
    refs.defaults.type = 'button'; refs.defaults.id = 'ws-defaults';
    refs.defaults.title = '还原场景、镜头、歌词和工坊效果，保留已保存的作品';
    refs.defaults.addEventListener('click', restoreDefaults);
    $('ws-close').before(refs.defaults);

    var bar = $('ws-tabs');
    refs.tabs = {};
    if (bar) {
      TABS.forEach(function (t) {
        var b = h('button', 'ws-tab', t[1]);
        b.type = 'button';
        b.addEventListener('click', function () { tab = t[0]; render(); });
        bar.appendChild(b);
        refs.tabs[t[0]] = b;
      });
    }
    var close = $('ws-close');
    if (close) close.addEventListener('click', function () { setOpen(false); });
    // 顶栏那个按钮不在这里绑：app.js 的 initCreative 同时接顶栏与设置页两个入口，
    // 两边都走 Workshop.toggle。这里再绑一次就等于一次点击翻两遍开关 ——
    // 面板开了立刻被第二个 handler 关掉，看起来就是"按钮没反应"。
    // 一个控件只能有一个主人。

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); return; }
      sceneArtKey(e);
      if (target === 'immersive' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        e.preventDefault(); e.stopImmediatePropagation(); travel(!e.shiftKey); return;
      }
      if (e.key === 'Tab') {
        var scope = target === 'immersive' ? $('stage3d') : refs.panel;
        var focusable = Array.from(scope.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')).filter(function (el) { return el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'; });
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      // Leave native control keys intact but keep global player shortcuts from
      // changing the underlying view while this editor has keyboard focus.
      if (refs.panel.contains(e.target)) e.stopPropagation();
    }, true);

    // 外部改动了预置（导演换段、绑定、导入）时，如果面板正开着就跟着刷新。
    // 但只在"结构变了"的时候刷：每帧都重排 DOM 会让正在拖的滑块失焦。
    if (window.CreativeStage && CreativeStage.onChange) {
      CreativeStage.onChange(function (kind) {
        if (arrangementState.plan && arrangementState.plan.revision !== CreativeStage.revision()) {
          arrangementState.plan = null; arrangementState.message = '舞台已改变，请重新检查分段。';
          var arrangementApply = refs.body.querySelector('[data-arrangement="apply"]');
          var arrangementPreview = refs.body.querySelector('[data-arrangement-preview]');
          var arrangementMessage = refs.body.querySelector('[data-arrangement-status]');
          if (arrangementApply) arrangementApply.disabled = true;
          if (arrangementPreview) arrangementPreview.textContent = '';
          if (arrangementMessage) arrangementMessage.textContent = arrangementState.message;
        }
        if (['preset', 'param', 'background', 'hand'].indexOf(kind) >= 0) {
          shareEditRevision += 1;
          var status = $('ws-share-status');
          if (status && /^正在/.test(status.textContent)) status.textContent = '预置已修改，本次操作已取消；请重新操作';
        }
        if (!isOpen() || target !== 'advanced') return;
        syncStageStatus();
        var invalidated = draftState.token && (!CreativeStage.preview()
          || CreativeStage.preview().previewId !== draftState.token.previewId);
        if (invalidated) { discardDraft(); }
        if (kind === 'preset' || kind === 'library' || invalidated) render();
      });
    }

    // 接管态变化**不经过 CreativeStage**，所以上面那条订阅永远收不到。
    // 少了这一条会得到一个很难自查的现象：用户在设置里把歌词视觉切成
    // 商籁，工坊面板还是那副可编辑的样子 —— 参数照拖、说明不出现，
    // 直到手动切一次页签才生效。所以这里单独跟一次锁定态，且只在
    // 「锁定的开/关」翻转时重渲染（每帧重排会打掉正在拖的滑块）。
    if (window.Stage3D && Stage3D.onVisualChange) {
      Stage3D.onVisualChange(function () {
        if (!isOpen()) return;
        syncStageStatus();
        if (target !== 'immersive') return;
        if (stanzaVisual() !== lastLock) render();
      });
    }
    new MutationObserver(function () { syncStageStatus(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', revealTab);
    document.addEventListener('visibilitychange', syncSceneArt);

    return api;
  }

  var api = {
    init: init,
    open: function () { if (isOpen()) { switchTarget('immersive'); return true; } target = 'immersive'; return setOpen(true); },
    close: function () { return setOpen(false); },
    toggle: function () { return isOpen() ? setOpen(false) : api.open(); },
    isOpen: isOpen,
    isEditingAdvanced: function () { return isOpen() && target === 'advanced'; },
    setTab: function (t) {
      if (TABS.some(function (x) { return x[0] === t; })) { tab = t; if (isOpen()) switchTarget('advanced'); else target = 'advanced'; render(); }
      return tab;
    },
    render: render,
    onAiTask: onAiTask,
    tabs: function () { return TABS.map(function (t) { return t[0]; }); }
  };

  window.Workshop = api;
})();
