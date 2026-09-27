// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 舞台控制舱：右侧滑出的调参面板。
//
// 它不懂任何渲染逻辑，只做一件事——把滑块的值写成 <html> 上的 CSS 变量
// `--fx-<group>-<key>`，然后由 stage.css 里的 var() 消费。所以：
//
//   · 加一个旋钮 = 在 SCHEMA 里加一行（面板会自动生成控件）
//     + 在 stage.css 里挑个地方 var() 它
//   · 想接真实渲染（WebGL / canvas）也可以：面板会派发 `stagecontrol:change`
//     事件，监听者拿得到完整参数表
//
// 参数值与开关状态存在 localStorage，刷新后保持。

(function () {
  'use strict';

  var STORE_KEY = 'vmusic.stage.control';

  // 字体下拉值 → 真正的字体栈（经 fmt 写到 --lyric-font）。
  // 只列系统内置字体：不随软件分发任何字体文件，零版权风险。
  var FONT_STACKS = {
    system: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", ' +
      '"Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    hei: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
    kai: '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", serif',
    mono: '"SF Mono", "Cascadia Code", Consolas, "Courier New", monospace'
  };

  // -------------------------------------------------------------------------
  // 参数表
  //
  // 分五组：镜头光学 / 胶片材质 / 律动与粒子 / 舞台视角 / 全局覆盖。
  // 每个旋钮给出 label（中文名）、min/max/step、unit、默认值 default。
  // -------------------------------------------------------------------------
  var SCHEMA = [
    {
      id: 'lens',
      title: '镜头光学',
      items: [
        { key: 'bokeh', label: '句间留白', min: 0, max: 20, step: 1, unit: 'px', def: 3 },
        { key: 'chroma', label: '径向色散', min: 0, max: 12, step: 1, unit: 'px', def: 4 },
        { key: 'aberration', label: '镜头光学瑕疵', min: 0, max: 12, step: 1, unit: 'px', def: 3 },
        { key: 'distort', label: '胶片散眩', min: 0, max: 12, step: 1, unit: 'px', def: 2 },
        { key: 'bloom', label: '对比度辉映', min: 0, max: 12, step: 1, unit: 'px', def: 2 }
      ]
    },
    {
      id: 'grain',
      title: '胶片材质',
      items: [
        { key: 'grain', label: '胶片颗粒', min: 0, max: 40, step: 1, unit: '%', def: 4 },
        { key: 'halftone', label: '半调网点', min: 0, max: 40, step: 1, unit: '%', def: 0 },
        { key: 'vignette', label: '镜头暗角', min: 0, max: 100, step: 1, unit: '%', def: 12 },
        { key: 'softness', label: '光晕柔化', min: 0, max: 20, step: 1, unit: 'px', def: 0 }
      ]
    },
    {
      id: 'motion',
      title: '律动与粒子',
      // 这一组和上面几组不同：值不靠 stage.css 的 var() 消费，而是由
      // stage-particles.js 监听 stagecontrol:change 事件后直接吃。
      // 面板本身仍然只管"把值写成变量 + 广播事件"，不需要知道有没有渲染器。
      items: [
        { key: 'dust', label: '启用舞台粒子', type: 'toggle', def: true },
        { key: 'ripples', label: '节拍涟漪', type: 'toggle', def: true },
        { key: 'density', label: '光尘密度', min: 0, max: 200, step: 5, unit: '%', def: 100 },
        { key: 'strength', label: '律动强度', min: 0, max: 200, step: 5, unit: '%', def: 100, wide: true },
        // 键名带 dust 前缀是必需的，不是命名癖：参数表在 values/els 里是一张扁平
        // 映射，旋钮之间重名会让两颗滑块共用同一个值——拖一颗另一颗跟着动，
        // 而且 reset 只回得来后注册的那一个。
        { key: 'dustDrift', label: '上浮速度', min: 0, max: 200, step: 5, unit: '%', def: 100 }
      ]
    },
    {
      id: 'lyrics',
      title: '歌词排版',
      items: [
        { key: 'lyricSize', label: '歌词字号', min: 70, max: 160, step: 5, unit: '%', def: 100,
          css: '--lyric-size-scale', fmt: function (v) { return (v / 100).toFixed(2); } },
        // 律动幅度由 stage.js 监听 stagecontrol:change 读取（放大起音包络）。
        // 默认 80%：明显跟节奏但不晃眼；0 = 完全静止的歌词。
        { key: 'beatAmp', label: '律动幅度', min: 0, max: 200, step: 5, unit: '%', def: 80, wide: true },
        // '' = 自动（跟随封面取色/主题）；具体颜色经 --lyric-color 覆盖。
        { key: 'lyricColor', label: '歌词颜色', type: 'color', def: '' }
      ],
      selects: [
        {
          key: 'lyricFont', label: '歌词字体', def: 'system',
          css: '--lyric-font',
          options: [['system', '系统默认'], ['hei', '黑体'], ['serif', '衬线'],
            ['kai', '楷体'], ['mono', '等宽']],
          fmt: function (v) { return FONT_STACKS[v] || FONT_STACKS.system; }
        }
      ]
    },
    {
      id: 'cine',
      title: '电影镜头',
      // 这一组不落任何 CSS 变量：由 stage-cinema.js / stage-freecam.js 监听
      // stagecontrol:change 事件直接消费（push() 对 cine 组整体跳过）。
      items: [
        { key: 'cinema', label: '电影镜头', type: 'toggle', def: true },
        { key: 'cinePunch', label: '冲击强度', min: 0, max: 200, step: 5, unit: '%', def: 100, wide: true },
        // 真正的键鼠操控在 stage-freecam.js；perfTier 0 时该模块隐藏本开关。
        { key: 'freecam', label: '自由相机', type: 'toggle', def: false }
      ]
    },
    {
      id: 'global',
      title: '全局覆盖',
      items: [
        // 总开关。它决定 html 上有没有 .fx-on：关掉时滤镜层整体不参与合成，
        // 比把每个强度调成 0 更彻底（省掉一层 blur/混合）。
        // 默认开启：此前默认关闭时，用户拖动镜头/胶片组旋钮毫无反应，
        // 被误认为「配置不生效」。滤镜幅度都很轻微，不影响界面可读性。
        { key: 'enabled', label: '启用舞台滤镜', type: 'toggle', def: true },
        { key: 'intensity', label: '滤镜强度', min: 0, max: 200, step: 1, unit: '%', def: 100, wide: true }
      ],
      selects: [
        {
          key: 'stagePreset', label: '舞台主题', def: 'venue',
          options: [['venue', '第一现场 · 舞台'], ['diorama', '纸雕剧场'], ['tempo', '节拍律动'], ['still', '静帧']]
        }
      ]
    }
  ];

  var values = {};
  var els = {};
  var open = false;

  function $(id) { return document.getElementById(id); }

  function defaults() {
    var out = { enabled: true };
    SCHEMA.forEach(function (g) {
      (g.items || []).forEach(function (it) { out[it.key] = it.def; });
      (g.selects || []).forEach(function (it) { out[it.key] = it.def; });
    });
    return out;
  }

  function load() {
    values = defaults();
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式 */ }
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      // 一次性迁移：52 是旧版默认尺寸。保留它会让"铺满短边"的新默认
      // 永远被旧存档盖掉；删掉让其回落到新默认 100
      if (saved.coverSize === 52) delete saved.coverSize;
      // 一次性迁移：滤镜总开关新默认是「启用」。老存档里存着 false 会把
      // 新默认盖掉（用户拖任何光学旋钮都无反应）。版本标记只做一次，
      // 迁移后用户手动关闭的选择照常被保存。
      var ver = null;
      try { ver = localStorage.getItem(STORE_KEY + '.v'); } catch (e) { /* ignore */ }
      if (ver !== '2') {
        delete saved.enabled;
        try { localStorage.setItem(STORE_KEY + '.v', '2'); } catch (e) { /* ignore */ }
      }
      Object.keys(saved).forEach(function (k) {
        if (k in values) values[k] = saved[k];
      });
    } catch (e) { /* 坏数据就当没存过 */ }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(values)); } catch (e) { /* 隐私模式 */ }
  }

  // -------------------------------------------------------------------------
  // 写入 CSS 变量
  //
  // 每个旋钮落到 --fx-<group>-<key>，全局组的 --fx-global-<key>。
  // 单独再写一份 --fx-intensity 作为总强度系数，让 stage.css 一次性乘上去，
  // 避免每个效果各自乘一遍、改强度时要动十几处规则。
  // -------------------------------------------------------------------------
  function hexTriplet(c) {
    var n = parseInt(String(c).slice(1), 16);
    return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
  }

  function push() {
    var root = document.documentElement.style;
    SCHEMA.forEach(function (g) {
      (g.items || []).forEach(function (it) {
        var v = values[it.key];
        // 取色器：有效值写入 --lyric-color/-rgb；空（自动）→ 移除属性，
        // stage.css 的 var() 回落到封面取色/主题色。
        if (it.type === 'color') {
          var c = String(v || '');
          if (/^#[0-9a-fA-F]{6}$/.test(c)) {
            root.setProperty('--lyric-color', c);
            root.setProperty('--lyric-color-rgb', hexTriplet(c));
          } else {
            root.removeProperty('--lyric-color');
            root.removeProperty('--lyric-color-rgb');
          }
          return;
        }
        // 带 css 的旋钮写到舞台令牌上，可以是一个名字或一组名字（心象散开
        // 要同时改 x/y/旋转三个量）；其余仍走通用的 --fx-<组>-<键>。
        if (it.css) {
          var names = [].concat(it.css);
          var out = it.fmt ? it.fmt(v) : String(v);
          var vals = [].concat(out);
          for (var i = 0; i < names.length; i += 1) {
            root.setProperty(names[i], vals[i % vals.length]);
          }
          return;
        }
        // global.intensity 的真实消费变量是单独写的 --fx-intensity，
        // 不再写一份无人读取的 --fx-global-intensity。
        if (g.id === 'global' && it.key === 'intensity') return;
        // cine 组只走事件，不写 --fx-cine-* 脏变量。
        if (g.id === 'cine') return;
        root.setProperty('--fx-' + g.id + '-' + it.key, String(v));
      });
      (g.selects || []).forEach(function (it) {
        var v = values[it.key];
        // 下拉也支持 css/fmt（歌词字体要把选项映射成字体栈）
        if (it.css) {
          var names = [].concat(it.css);
          var out = it.fmt ? it.fmt(v) : String(v);
          var vals = [].concat(out);
          for (var i = 0; i < names.length; i += 1) {
            root.setProperty(names[i], vals[i % vals.length]);
          }
          return;
        }
        root.setProperty('--fx-' + g.id + '-' + it.key, String(v));
      });
    });
    root.setProperty('--fx-intensity', (values.intensity / 100).toFixed(3));
    document.documentElement.classList.toggle('fx-on', !!values.enabled);
    document.documentElement.dataset.stagePreset = values.stagePreset;
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('stagecontrol:change', {
      detail: JSON.parse(JSON.stringify(values))
    }));
  }

  // -------------------------------------------------------------------------
  // 面板构建
  // -------------------------------------------------------------------------

  function buildSlider(groupId, it) {
    var cell = document.createElement('div');
    cell.className = 'sc-cell' + (it.wide ? ' is-wide' : '') + (it.type === 'toggle' ? ' is-toggle' : '');
    var id = 'sc-' + groupId + '-' + it.key;

    var head = document.createElement('label');
    head.className = 'sc-label';
    head.setAttribute('for', id);
    var name = document.createElement('span');
    name.textContent = it.label;
    var val = document.createElement('span');
    val.className = 'sc-value';
    head.append(name, val);
    cell.appendChild(head);

    if (it.type === 'toggle') {
      var sw = document.createElement('button');
      sw.type = 'button';
      sw.id = id;
      sw.className = 'sc-switch';
      sw.setAttribute('role', 'switch');
      var setSw = function (on) {
        sw.classList.toggle('on', !!on);
        sw.setAttribute('aria-checked', String(!!on));
      };
      setSw(values[it.key]);
      sw.addEventListener('click', function () {
        values[it.key] = !values[it.key];
        setSw(values[it.key]);
        push(); save(); emit();
      });
      cell.appendChild(sw);
      els[it.key] = { set: function (v) { setSw(v); } };
      return cell;
    }

    var input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(it.min);
    input.max = String(it.max);
    input.step = String(it.step);
    input.value = String(values[it.key]);
    val.textContent = values[it.key] + (it.unit || '');

    // 轨道填充色：CSS 用 var(--fill) 画已走过的那一段，这里按比例写回去。
    var paintFill = function (v) {
      var min = Number(it.min), max = Number(it.max);
      var pct = max > min ? ((Number(v) - min) / (max - min)) * 100 : 0;
      input.style.setProperty('--fill', pct.toFixed(1) + '%');
    };
    paintFill(values[it.key]);

    input.addEventListener('input', function () {
      var v = Number(input.value);
      values[it.key] = v;
      val.textContent = v + (it.unit || '');
      paintFill(v);
      push(); save(); emit();
    });
    // 拖动过程不写 localStorage：一次拖动会触发几十次写入，
    // 换成松手时落盘，行为一样但省掉了同步 IO。
    input.addEventListener('change', save);

    cell.appendChild(input);
    els[it.key] = {
      set: function (v) {
        input.value = String(v);
        val.textContent = v + (it.unit || '');
        paintFill(v);
      }
    };
    return cell;
  }

  function buildSelect(groupId, it) {
    var cell = document.createElement('div');
    cell.className = 'sc-cell';
    var id = 'sc-' + groupId + '-' + it.key;
    var head = document.createElement('label');
    head.className = 'sc-label';
    head.setAttribute('for', id);
    head.textContent = it.label;
    cell.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'sc-select-wrap';
    var sel = document.createElement('select');
    sel.id = id;
    it.options.forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      sel.appendChild(o);
    });
    sel.value = String(values[it.key]);
    sel.addEventListener('change', function () {
      values[it.key] = sel.value;
      push(); save(); emit();
    });
    wrap.appendChild(sel);
    cell.appendChild(wrap);
    els[it.key] = { set: function (v) { sel.value = String(v); } };
    return cell;
  }

  // 取色器单元格：色盘 + 「自动」按钮（空值 = 跟随封面/主题）。
  function buildColor(groupId, it) {
    var cell = document.createElement('div');
    cell.className = 'sc-cell is-color';
    var id = 'sc-' + groupId + '-' + it.key;

    var head = document.createElement('label');
    head.className = 'sc-label';
    head.setAttribute('for', id);
    var name = document.createElement('span');
    name.textContent = it.label;
    var state = document.createElement('span');
    state.className = 'sc-value';
    head.append(name, state);
    cell.appendChild(head);

    var row = document.createElement('div');
    row.className = 'sc-color-row';
    var input = document.createElement('input');
    input.type = 'color';
    input.id = id;
    input.setAttribute('aria-label', it.label);
    input.value = values[it.key] || '#888888';

    var auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'sc-color-auto';
    auto.textContent = '自动';

    function render() {
      var c = values[it.key];
      state.textContent = c || '跟随封面';
      auto.classList.toggle('is-on', !c);
      input.classList.toggle('is-auto', !c);
    }

    input.addEventListener('input', function () {
      values[it.key] = input.value;
      render(); push(); save(); emit();
    });
    auto.addEventListener('click', function () {
      values[it.key] = '';
      input.value = '#888888';
      render(); push(); save(); emit();
    });

    row.append(input, auto);
    cell.appendChild(row);
    els[it.key] = {
      set: function (v) {
        input.value = v || '#888888';
        render();
      }
    };
    render();
    return cell;
  }

  function build() {
    var host = $('sc-body');
    if (!host) return;
    host.textContent = '';

    SCHEMA.forEach(function (g) {
      var sec = document.createElement('section');
      sec.className = 'sc-group';
      var h = document.createElement('h2');
      h.className = 'sc-group-title';
      h.textContent = g.title;
      sec.appendChild(h);

      var grid = document.createElement('div');
      grid.className = 'sc-grid';
      (g.items || []).forEach(function (it) {
        grid.appendChild(it.type === 'color'
          ? buildColor(g.id, it) : buildSlider(g.id, it));
      });
      (g.selects || []).forEach(function (it) {
        grid.appendChild(buildSelect(g.id, it));
      });
      sec.appendChild(grid);

      if (g.id === 'global') {
        var note = document.createElement('div');
        note.className = 'sc-note';
        note.textContent = '所有参数实时写入 CSS 变量，与当前播放状态同步生效。';
        sec.appendChild(note);
      }
      host.appendChild(sec);
    });
  }

  // -------------------------------------------------------------------------
  // 开合
  // -------------------------------------------------------------------------

  function setOpen(next) {
    var want = next === undefined ? !open : !!next;
    open = want;
    var panel = $('stage-ctl');
    if (!panel) return;
    // 面板默认 hidden，只有真正要展开时才上屏——否则它会一直挂在合成层里。
    panel.hidden = false;
    void panel.offsetWidth; // 强制回流：hidden → is-open 同帧合并会吃掉过渡
    panel.classList.toggle('is-open', want);
    panel.setAttribute('aria-hidden', String(!want));
    document.body.classList.toggle('sc-open', want);
    var btn = $('stage-control-btn');
    if (btn) {
      btn.classList.toggle('active', want);
      btn.setAttribute('aria-expanded', String(want));
    }
  }

  function reset() {
    // 恢复默认只清参数，不关掉总开关——用户点"恢复出厂"通常是想清掉
    // 自己调歪的数值，而不是让面板整个失效。
    var keepEnabled = values.enabled;
    values = defaults();
    values.enabled = keepEnabled;
    SCHEMA.forEach(function (g) {
      (g.items || []).forEach(function (it) { if (els[it.key]) els[it.key].set(values[it.key]); });
      (g.selects || []).forEach(function (it) { if (els[it.key]) els[it.key].set(values[it.key]); });
    });
    push(); save(); emit();
  }

  function init() {
    load();
    build();
    push();

    var btn = $('stage-control-btn');
    if (btn) btn.addEventListener('click', function () { setOpen(); });
    var close = $('sc-close');
    if (close) close.addEventListener('click', function () { setOpen(false); });
    var ok = $('sc-ok');
    if (ok) ok.addEventListener('click', function () { setOpen(false); });
    var rst = $('sc-reset');
    if (rst) rst.addEventListener('click', reset);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
    }, true);

    emit();
  }

  window.StageControl = {
    init: init,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(); },
    isOpen: function () { return open; },
    // 读当前参数表（调试与自动化测试用）
    values: function () { return JSON.parse(JSON.stringify(values)); },
    set: function (patch) {
      Object.keys(patch || {}).forEach(function (k) {
        if (k in values) values[k] = patch[k];
      });
      Object.keys(patch || {}).forEach(function (k) {
        if (els[k] && els[k].set) els[k].set(values[k]);
      });
      push(); save(); emit();
    },
    reset: reset,
    // 扩展方式：StageControl.addGroup({ id, title, items: [...] })
    addGroup: function (group) {
      if (!group || !group.id || !group.title) return false;
      (group.items || []).forEach(function (it) {
        if (!(it.key in values)) values[it.key] = it.def;
      });
      SCHEMA.push(group);
      build();
      push();
      return true;
    }
  };
})();
