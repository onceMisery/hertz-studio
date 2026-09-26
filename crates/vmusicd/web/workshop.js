// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
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
// 五个页签对应五种编辑动作，而不是五种界面：场景（选）+ 参数（调）+
// 编排（排）+ 绑定（接）+ 保存（传）。

(function () {
  'use strict';

  var tab = 'scene';
  var refs = {};
  var lastParamPath = null;
  var GUIDE_KEY = 'vmusic.workshop.guide.v1';
  var helpSeq = 0;
  var target = 'immersive', returnFocus = null, home = null;
  var past = [], future = [], gesture = null;
  var DEFAULTS = { scene: 'resonance', motion: .65, bloom: .8, reactivity: 1.35, lyrics: true, cruise: true, layout: 'focus', lyricSize: 1, lyricGlow: .45 };

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

  function renderScene(body) {
    var CS = stage_api();
    var cur = CS.preset();

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

    body.appendChild(h('h2', 'sc-group-title', '三维场景'));
    var grid = h('div', 'ws-cards');
    CS.scenes().forEach(function (s) {
      var card = h('button', 'ws-card');
      card.type = 'button';
      card.classList.toggle('on', s.id === cur.scene);
      card.innerHTML = sceneArt(s.id);
      card.appendChild(h('span', 'ws-card-name', s.label));
      card.setAttribute('aria-pressed', String(s.id === cur.scene));
      card.addEventListener('click', function () { CS.setScene(s.id); render(); });
      grid.appendChild(card);
    });
    body.appendChild(grid);

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

  function renderPresets(body) {
    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '工坊收藏'));
    head.appendChild(help('收藏只保存在本机；载入会立即替换当前舞台，删除前会再次确认。'));
    body.appendChild(head);
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
      var btns = h('div', 'ws-shot-btns');
      var load = h('button', 'btn', '载入并应用');
      load.addEventListener('click', function () {
        CS.loadPresetById(p.id);
        flash('已载入');
        render();
      });
      var del = h('button', 'btn danger', '删除');
      del.addEventListener('click', function () {
        if (!window.confirm('删除收藏「' + (p.name || '未命名') + '」？')) return;
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

  function renderCues(body) {
    var CS = stage_api();
    var cur = CS.preset();
    var rt = CS.runtime();

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
      CS.addCue(cue);
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
        cue.len = Number(lenInp.value) || 600;
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
      CS.setBindings(list);
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

  function renderLook(body) {
    var CS = stage_api();
    var cur = CS.preset();

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
        '图片与视频都只在本机内存里，不上传、不落库；换台机器打不开是预期行为。'
        + '视频会自动降速播放并降采样，避免和三维舞台抢解码器。'));
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
        ['scene', '弧形墙（WebGL2）']
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
        var texInfo = st.wallTex ? '，纹理 ' + st.wallTex[0] + '×' + st.wallTex[1] : '';
        body.appendChild(h('div', 'sc-note',
          '弧形墙运行中' + texInfo + '，移动指针环顾；墙内亮度随音乐能量起伏。'));
      }

      var info = '当前调色：' + st.palette.join('  ');
      if (bg.type !== 'media') info += '　（' + st.size + ' 像素的离屏画布放大）';
      body.appendChild(h('div', 'sc-note', info));
    }

    body.appendChild(h('h2', 'sc-group-title', '手绘舞台'));
    var hand = cur.hand || { on: false };
    var opts = h('div', 'sc-grid');
    opts.appendChild(toggle('启用手绘风格', hand.on, function (v) {
      var next = Object.assign({}, hand, { on: v });
      CS.setHandDrawn(next);
      render();
    }));
    if (hand.on) {
      opts.appendChild(toggle('手绘边框', hand.frame !== false, function (v) {
        var next = Object.assign({}, hand, { frame: v, on: true });
        CS.setHandDrawn(next);
      }));
      opts.appendChild(toggle('手绘声波', hand.wave !== false, function (v) {
        var next = Object.assign({}, hand, { wave: v, on: true });
        CS.setHandDrawn(next);
      }));
      opts.appendChild(toggle('歌词圈注', hand.annot !== false, function (v) {
        var next = Object.assign({}, hand, { annot: v, on: true });
        CS.setHandDrawn(next);
      }));
      opts.appendChild(toggle('纸张噪点', hand.paper !== false, function (v) {
        var next = Object.assign({}, hand, { paper: v, on: true });
        CS.setHandDrawn(next);
      }));
    }
    body.appendChild(opts);
    if (hand.on) {
      var jgrid = h('div', 'sc-grid');
      jgrid.appendChild(slider(['hand.jitter', '抖动幅度', 0, 200, 5, '%', 100],
        hand.jitter === undefined ? 100 : hand.jitter, function (v) {
          CS.setHandDrawn(Object.assign({}, hand, { on: true, jitter: v }));
        }));
      jgrid.appendChild(slider(['hand.speed', '刷新速度', 20, 200, 5, '%', 100],
        hand.speed === undefined ? 100 : hand.speed, function (v) {
          CS.setHandDrawn(Object.assign({}, hand, { on: true, speed: v }));
        }));
      body.appendChild(jgrid);
      body.appendChild(h('div', 'sc-note',
        '手绘层跑在约 16fps 上。这不是省事，是观感：逐帧全速的"手绘"看起来像噪点，'
        + '不像笔触。'));
    }
  }

  function renderIO(body) {
    var CS = stage_api();
    var head = h('div', 'ws-section-head');
    head.appendChild(h('h2', 'sc-group-title', '导出 / 导入'));
    head.appendChild(help('先复制或下载 JSON；把别人的 JSON 粘贴到文本框后点“载入这段 JSON”。'));
    body.appendChild(head);
    body.appendChild(h('div', 'sc-note',
      '一份预置就是一段 JSON：场景、全部参数、cue 轨、绑定、背景与手绘设置。'
      + '把这段文字发给别人，对面粘进来就能得到一模一样的舞台。'));

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

  // Static visual studies are navigational thumbnails; the adjacent canvas is
  // the actual renderer. No second animation loop or renderer lives here.
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
  function renderImmersive(body) {
    var prefs = snapshot();
    var intro = h('div', 'ws-intro');
    intro.append(h('span', 'ws-kicker', 'THE LISTENING ROOM'), h('h2', null, '给音乐一个空间'), h('p', null, '挑选声场，调整光与节奏。每一次改变，即刻呈现在预览中。'));
    body.appendChild(intro);
    var history = h('div', 'ws-history');
    [['ws-undo', '撤销', function () { travel(true); }], ['ws-redo', '重做', function () { travel(false); }], ['ws-defaults', '恢复默认', function () { edit(DEFAULTS); }]].forEach(function (spec) {
      var b = h('button', 'btn', spec[1]); b.type = 'button'; b.id = spec[0]; b.addEventListener('click', spec[2]); history.appendChild(b);
    });
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
      b.addEventListener('click', function () { edit(Object.assign({}, DEFAULTS, spec[2])); }); templates.appendChild(b);
    });
    body.appendChild(templates);
    body.appendChild(h('h3', 'ws-section-title', '选择声场'));
    var scenes = h('div', 'ws-scene-grid');
    Stage3D.stages().forEach(function (scene) {
      var b = h('button', 'ws-scene-card'); b.type = 'button'; b.dataset.scene = scene.id; b.id = 'ws-scene-' + scene.id;
      b.setAttribute('aria-pressed', String(scene.id === prefs.scene)); b.innerHTML = sceneArt(scene.id);
      b.append(h('strong', null, scene.label), h('small', null, scene.desc));
      b.addEventListener('click', function () { edit({ scene: scene.id }); }); scenes.appendChild(b);
    });
    body.appendChild(scenes);
    body.appendChild(h('h3', 'ws-section-title', '光与节奏'));
    var controls = h('div', 'ws-tuning');
    [ ['reactivity', '律动强度', 0, 2, .05, '', 1.35], ['motion', '镜头动态', 0, 1, .05, '', .65], ['bloom', '光晕强度', 0, 1.5, .05, '', .8] ].forEach(function (row) { controls.appendChild(immersiveSlider(row, prefs)); });
    controls.appendChild(toggle('镜头自动巡航', prefs.cruise, function (v) { edit({ cruise: v }); }));
    controls.querySelector('[role="switch"]').id = 'ws-cruise';
    body.appendChild(controls);
    body.appendChild(h('h3', 'ws-section-title', '封面与歌词'));
    var reading = h('div', 'ws-tuning');
    reading.appendChild(select('聆听布局', [['focus', '沉浸歌词'], ['sleeve', '封面与歌词'], ['single', '简洁单句']], prefs.layout, function (v) { edit({ layout: v }); }));
    reading.appendChild(toggle('显示歌词', prefs.lyrics, function (v) { edit({ lyrics: v }); }));
    reading.querySelector('select').id = 'ws-layout';
    reading.querySelector('label').htmlFor = 'ws-layout';
    reading.querySelector('[role="switch"]').id = 'ws-lyrics';
    reading.appendChild(immersiveSlider(['lyricSize', '歌词字号', .75, 1.35, .05, '×', 1], prefs));
    reading.appendChild(immersiveSlider(['lyricGlow', '字间柔光', 0, 1, .05, '', .45], prefs));
    body.appendChild(reading);
    body.appendChild(h('p', 'ws-save-note', '设置自动保存 · 关闭工坊，继续沉浸聆听'));
    syncHistory();
  }

  function switchTarget(next) {
    if (target === next) return;
    setOpen(false); target = next;
    if (next === 'advanced') {
      Stage3D.close();
      document.dispatchEvent(new CustomEvent('workshop:target', { detail: { target: next } }));
    } else if (window.Stage && Stage.setPage) Stage.setPage(false);
    setOpen(true);
  }

  var TABS = [
    ['scene', '场景'], ['presets', '收藏'], ['params', '参数'], ['cues', '编排'],
    ['binds', '绑定'], ['look', '背景手绘'], ['io', '导出']
  ];

  function render() {
    if (!refs.body) return;
    var scroll = refs.body.scrollTop;
    var focused = document.activeElement;
    var focusId = refs.body.contains(focused) && focused.id;
    refs.panel.dataset.target = target;
    refs.targets.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.target === target)); });
    $('ws-tabs').hidden = target !== 'advanced';
    refs.body.textContent = '';
    if (target === 'immersive') {
      renderImmersive(refs.body); refs.body.scrollTop = scroll;
      if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
      return;
    }
    TABS.forEach(function (t) {
      if (refs.tabs && refs.tabs[t[0]]) refs.tabs[t[0]].classList.toggle('on', tab === t[0]);
    });
    if (tab === 'scene') renderScene(refs.body);
    else if (tab === 'presets') renderPresets(refs.body);
    else if (tab === 'params') renderParams(refs.body);
    else if (tab === 'cues') renderCues(refs.body);
    else if (tab === 'binds') renderBindings(refs.body);
    else if (tab === 'look') renderLook(refs.body);
    else renderIO(refs.body);
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
    if (next) {
      returnFocus = document.activeElement;
      if (target === 'immersive' && window.Stage3D) {
        if (!Stage3D.isActive()) Stage3D.open();
        $('stage3d').appendChild(panel);
        $('stage3d').classList.add('s3d-editing', 's3d-chrome');
      }
      panel.inert = false;
    } else {
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
      if (target === 'immersive' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        e.preventDefault(); e.stopImmediatePropagation(); travel(!e.shiftKey); return;
      }
      if (e.key === 'Tab') {
        var scope = target === 'immersive' ? $('stage3d') : refs.panel;
        var focusable = Array.from(scope.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea')).filter(function (el) { return el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'; });
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
        if (!isOpen() || target !== 'advanced') return;
        if (kind === 'preset' || kind === 'library') render();
      });
    }
    return api;
  }

  var api = {
    init: init,
    open: function () { if (isOpen()) { switchTarget('immersive'); return true; } target = 'immersive'; return setOpen(true); },
    close: function () { return setOpen(false); },
    toggle: function () { return isOpen() ? setOpen(false) : api.open(); },
    isOpen: isOpen,
    setTab: function (t) {
      if (TABS.some(function (x) { return x[0] === t; })) { tab = t; if (isOpen()) switchTarget('advanced'); else target = 'advanced'; render(); }
      return tab;
    },
    render: render,
    tabs: function () { return TABS.map(function (t) { return t[0]; }); }
  };

  window.Workshop = api;
})();
