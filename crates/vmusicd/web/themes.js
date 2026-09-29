// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 多主题色：把 VCP Music 已有的一批主题配色搬过来，映射到本项目的令牌上。
//
// 设计原则
// --------
// 1. **只声明语义令牌，不写选择器**。每套主题就是一张 { token: value } 表，
//    applyTheme() 把它写成 <html> 上的行内 CSS 变量；style.css / stage.css
//    里已有的 var(--xxx) 自动跟着变。加主题 = 往 CATALOG 里加一条，不用改样式。
// 2. **颜色是唯一的自由量**。结构令牌（圆角、尺寸、缓动）不放进主题表，
//    避免换色顺手把布局也换掉。
// 3. **对比度由构建期保证**。每套主题的 `--text` / `--muted` 都按 WCAG AA
//    （正文 4.5:1、次要文字 3:1）从各自的 --bg 反推过，见下方 contrast 注释；
//    `--accent-ink` 是在 accent 底色上放文字时用的前景色，专门解决
//    "按钮换色后白字看不清"这一类问题。
//
// 扩展方式（见文末 Stage/Theme.register）。

(function () {
  'use strict';

  // v2：默认主题换成了「星蓝深空」，用新的存储键让所有人从新的默认起步；
  // 旧键里的选择不会丢，只是不再作为默认值——想找回旧主题在菜单里点一下即可。
  var STORE_KEY = 'vmusic.theme.v2';
  var ATTR = 'data-theme';

  // -------------------------------------------------------------------------
  // 内置主题
  //
  // 每一项来自 VCPChat `styles/themes/*.css`：把那里的 --primary-bg /
  // --secondary-bg / --button-bg / --highlight-text 等映射到本项目令牌。
  // -------------------------------------------------------------------------
  var CATALOG = [
    {
      id: 'mineral',
      name: '矿石黑（默认）',
      note: '矿石黑 · 近黑底 + 纯白强调 + 薄荷青辉光',
      // 对比度（自 --bg 反推，WCAG AA）：text ≈ 15.6 / muted ≈ 7.4
      tokens: {
        '--bg': '#0A0A0A',
        '--panel': 'rgba(20, 20, 21, 0.72)',
        '--panel-solid': '#121213',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': '#1C1D20',
        '--line-strong': '#26272B',
        '--text': '#E8ECEF',
        '--muted': '#8A9099',
        '--accent': '#FFFFFF',
        '--accent-2': '#00F5D4',
        '--accent-ink': '#0A0A0A',
        '--brand': '#00F5D4',
        '--brand-rgb': '0, 245, 212',
        '--highlight': '#F4D28A',
        '--highlight-rgb': '244, 210, 138',
        '--hover': 'rgba(255, 255, 255, 0.07)'
      }
    },
    {
      id: 'vcp-starblue',
      name: '星蓝深空',
      note: '参考 VCP 全屏星蓝：深空蓝黑底 + 科技蓝强调色',
      // 对比度（自 --bg 反推，WCAG AA）：
      //   text/bg ≈ 14.2  muted/bg ≈ 7.2  accent-ink/accent ≈ 5.7
      tokens: {
        '--bg': '#0b1020',
        '--panel': 'rgba(19, 26, 48, 0.66)',
        '--panel-solid': '#131a30',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(148, 168, 220, 0.12)',
        '--line-strong': 'rgba(148, 168, 220, 0.22)',
        '--text': '#e8edf8',
        '--muted': '#94a0bd',
        '--accent': '#4c8dff',
        '--accent-2': '#7a5cff',
        '--accent-ink': '#0a1230',
        '--hover': 'rgba(120, 150, 230, 0.10)'
      }
    },
    {
      id: 'vcp-emerald',
      name: '翡翠夜',
      note: 'VCP 原生气质：墨绿底 + 翡翠强调色',
      tokens: {
        '--bg': '#0d0f12',
        '--panel': 'rgba(24, 27, 32, 0.66)',
        '--panel-solid': '#171a1f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.09)',
        '--line-strong': 'rgba(255, 255, 255, 0.16)',
        '--text': '#eef1f5',
        '--muted': '#97a0af',
        '--accent': '#1dbf8f',
        '--accent-2': '#7f77dd',
        '--accent-ink': '#04140e',
        '--hover': 'rgba(255, 255, 255, 0.07)'
      }
    },
    {
      id: 'vcp-midnight-neon',
      name: '午夜霓虹',
      note: '午夜霓虹 · 深夜窗上反光的赛博粉',
      tokens: {
        '--bg': '#101116',
        '--panel': 'rgba(26, 27, 34, 0.72)',
        '--panel-solid': '#1a1b22',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#e8e9ed',
        '--muted': '#d1d1db',
        '--accent': '#ff4785',
        '--accent-2': '#7f77dd',
        '--accent-ink': '#2b0011',
        '--hover': 'rgba(255, 71, 133, 0.12)'
      }
    },
    {
      id: 'vcp-mono',
      name: '黑白简约',
      note: '黑白简约 · 克制的墨灰底 + 一点冷蓝强调',
      tokens: {
        '--bg': '#1c1c1e',
        '--panel': 'rgba(40, 40, 44, 0.72)',
        '--panel-solid': '#28282c',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.11)',
        '--line-strong': 'rgba(255, 255, 255, 0.20)',
        '--text': '#e6e6e6',
        '--muted': '#a8a8a8',
        '--accent': '#6fa8dc',
        '--accent-2': '#8f8f94',
        '--accent-ink': '#0b1b29',
        '--hover': 'rgba(255, 255, 255, 0.09)'
      }
    },
    {
      id: 'vcp-aero',
      name: '极简 Aero',
      note: '极简 Aero · 冷灰蓝的玻璃质感',
      tokens: {
        '--bg': '#252a30',
        '--panel': 'rgba(48, 54, 61, 0.72)',
        '--panel-solid': '#30363d',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#edf4f8',
        '--muted': '#aab7c1',
        '--accent': '#76b9e6',
        '--accent-2': '#79c99e',
        '--accent-ink': '#10212d',
        '--hover': 'rgba(118, 185, 230, 0.14)'
      }
    },
    {
      id: 'vcp-codeide',
      name: 'Code IDE',
      note: '代码编辑器 · 低饱和的暖琥珀',
      tokens: {
        '--bg': '#1a1d23',
        '--panel': 'rgba(37, 40, 48, 0.72)',
        '--panel-solid': '#252830',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#d7dde8',
        '--muted': '#98a3b5',
        '--accent': '#e5c07b',
        '--accent-2': '#7f9ed4',
        '--accent-ink': '#241b06',
        '--hover': 'rgba(229, 192, 123, 0.12)'
      }
    },
    {
      id: 'vcp-sakura',
      name: '夜樱猫语',
      note: '夜樱猫语 · 靛紫底上的樱粉',
      tokens: {
        '--bg': '#1a1a2e',
        '--panel': 'rgba(43, 43, 69, 0.72)',
        '--panel-solid': '#2b2b45',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e8e6f0',
        '--muted': '#a8a6bd',
        '--accent': '#ff8c94',
        '--accent-2': '#8f8fd6',
        '--accent-ink': '#2b0d10',
        '--hover': 'rgba(255, 140, 148, 0.13)'
      }
    },
    {
      id: 'vcp-crimson',
      name: '绯红天穹',
      note: '绯红天穹 · 高能的猩红强调',
      tokens: {
        '--bg': '#0d0f12',
        '--panel': 'rgba(26, 28, 32, 0.72)',
        '--panel-solid': '#1a1c20',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#eaebee',
        '--muted': '#a0a3ab',
        '--accent': '#ff3b5c',
        '--accent-2': '#9f1212',
        '--accent-ink': '#2a0008',
        '--hover': 'rgba(255, 59, 92, 0.14)'
      }
    },
    {
      id: 'vcp-paper-ink',
      name: '纸墨与机芯',
      note: '纸墨与机芯 · 米白纸感 + 黄铜齿轮',
      tokens: {
        '--bg': '#171a1d',
        '--panel': 'rgba(32, 37, 42, 0.72)',
        '--panel-solid': '#20252a',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#f2f0e9',
        '--muted': '#a7afb1',
        '--accent': '#f2a900',
        '--accent-2': '#76bfae',
        '--accent-ink': '#241800',
        '--hover': 'rgba(242, 169, 0, 0.12)'
      }
    },
    {
      id: 'vcp-forest',
      name: '静谧森岭',
      note: '静谧森岭 · 苔绿与蕨叶',
      tokens: {
        '--bg': '#1a201b',
        '--panel': 'rgba(42, 54, 47, 0.72)',
        '--panel-solid': '#2a362f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#e8e8e3',
        '--muted': '#a8b0a9',
        '--accent': '#7fbf7f',
        '--accent-2': '#587465',
        '--accent-ink': '#0a1a0c',
        '--hover': 'rgba(127, 191, 127, 0.13)'
      }
    },
    {
      id: 'vcp-porcelain',
      name: '瓷与锦',
      note: '瓷与锦 · 青花瓷的靛蓝与金线',
      tokens: {
        '--bg': '#0a1921',
        '--panel': 'rgba(13, 42, 56, 0.72)',
        '--panel-solid': '#0d2a38',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e0e6e9',
        '--muted': '#b3c6ce',
        '--accent': '#daa520',
        '--accent-2': '#3f8fa8',
        '--accent-ink': '#201704',
        '--hover': 'rgba(218, 165, 32, 0.13)'
      }
    },
    {
      id: 'vcp-snow-dawn',
      name: '雪境晨昏',
      note: '雪境晨昏 · 冷蓝夜幕与初升暖光',
      tokens: {
        '--bg': '#1a2333',
        '--panel': 'rgba(37, 47, 64, 0.72)',
        '--panel-solid': '#252f40',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e6edf3',
        '--muted': '#a3b0c2',
        '--accent': '#f7b731',
        '--accent-2': '#5b8dd9',
        '--accent-ink': '#241a02',
        '--hover': 'rgba(247, 183, 49, 0.13)'
      }
    },
    {
      id: 'vcp-acid',
      name: '酸性玄武',
      note: '酸性玄武 · 荧光黄绿的实验感',
      tokens: {
        '--bg': '#0d1013',
        '--panel': 'rgba(21, 25, 31, 0.72)',
        '--panel-solid': '#15191f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#f0f4f8',
        '--muted': '#a0abb8',
        '--accent': '#d4ff00',
        '--accent-2': '#2b3441',
        '--accent-ink': '#1c2200',
        '--hover': 'rgba(212, 255, 0, 0.12)'
      }
    },
    {
      id: 'liunian',
      name: '流年',
      note: '流年 · 旧纸暖褐底 + 沉金色的岁月流光',
      // 对比度（自 --bg 反推，WCAG AA）：
      //   text/bg ≈ 14.8  muted/bg ≈ 6.6  accent-ink/accent ≈ 7.8
      // 流年专属的 --liunian-vignette 是老照片暗角，仅 skin.liunian.css 消费。
      tokens: {
        '--bg': '#15110d',
        '--panel': 'rgba(38, 30, 22, 0.62)',
        '--panel-solid': '#211b14',
        '--panel-2': 'rgba(230, 196, 140, 0.05)',
        '--line': 'rgba(226, 190, 140, 0.10)',
        '--line-strong': 'rgba(226, 190, 140, 0.20)',
        '--text': '#f3e8d8',
        '--muted': '#ab9880',
        '--accent': '#d8ab60',
        '--accent-2': '#c0704e',
        '--accent-ink': '#241a08',
        '--brand': '#d8ab60',
        '--brand-rgb': '216, 171, 96',
        '--highlight': '#e7c687',
        '--highlight-rgb': '231, 198, 135',
        '--hover': 'rgba(216, 171, 96, 0.10)',
        '--liunian-vignette':
          'radial-gradient(125% 100% at 50% 38%, transparent 58%, rgba(18, 12, 6, 0.42) 100%)'
      }
    }
  ];

  var byId = new Map();
  CATALOG.forEach(function (t) { byId.set(t.id, t); });

  var current = null;
  var listeners = [];

  function root() { return document.documentElement; }

  function readStored() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  function writeStored(id) {
    try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* 隐私模式 */ }
  }

  // 把一套主题写到 <html> 的行内样式上。先清掉上一套留下的键，再写新的，
  // 否则从"自定义了 X"的主题切到"没定义 X"的主题时，X 会残留。
  function apply(id, opts) {
    var theme = byId.get(id) || CATALOG[0];
    var el = root();
    var prev = current;
    if (prev) {
      Object.keys(prev.tokens).forEach(function (k) {
        if (!(k in theme.tokens)) el.style.removeProperty(k);
      });
    }
    Object.keys(theme.tokens).forEach(function (k) {
      el.style.setProperty(k, theme.tokens[k]);
    });
    // accent 的 rgb 三元组：rgba() 透明度合成必须用原始数字，CSS 没法从
    // hex 变量里拆出来，所以换肤时顺手派生一份。舞台的 --music-highlight
    // 默认回退就吃这个值，无封面时与主题同色而不是固定琥珀。
    var accent = theme.tokens['--accent'];
    if (accent && /^#([0-9a-f]{6})$/i.test(accent)) {
      var n = parseInt(accent.slice(1), 16);
      el.style.setProperty('--accent-rgb',
        [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', '));
    }
    // 老主题里没有 --brand / --highlight 这两个角色色：这里按 accent / accent-2
    // 派生一份，保证统一组件层（激活态/焦点环/选中态）在任何主题下都有值，
    // 不会因为换肤而退化成空白描边。
    ['--brand', '--brand-rgb', '--highlight', '--highlight-rgb'].forEach(function (k) {
      if (theme.tokens[k]) return;
      if (k === '--brand') el.style.setProperty(k, theme.tokens['--accent-2'] || accent);
      else if (k === '--highlight') el.style.setProperty(k, theme.tokens['--accent']);
      else {
        var hex = k === '--brand-rgb'
          ? (theme.tokens['--accent-2'] || accent)
          : theme.tokens['--accent'];
        if (hex && /^#([0-9a-f]{6})$/i.test(hex)) {
          var m = parseInt(hex.slice(1), 16);
          el.style.setProperty(k, [(m >> 16) & 255, (m >> 8) & 255, m & 255].join(', '));
        }
      }
    });
    el.setAttribute(ATTR, theme.id);
    current = theme;
    if (!(opts && opts.silent)) writeStored(theme.id);
    // 主题色会被舞台取色覆盖到 --music-highlight 上，换主题要让它重新取一次
    if (window.Stage && typeof window.Stage.retint === 'function') window.Stage.retint();
    listeners.forEach(function (fn) {
      try { fn(theme); } catch (e) { /* 单个订阅者出错不该拖垮换肤 */ }
    });
    return theme;
  }

  // 带上 tokens：渲染主题菜单时要拿 accent 画色点，调用方不该再回头查一次。
  // 这里是拷贝，外部改不动 CATALOG。
  function list() {
    return CATALOG.map(function (t) {
      var tokens = {};
      Object.keys(t.tokens).forEach(function (k) { tokens[k] = t.tokens[k]; });
      return { id: t.id, name: t.name, note: t.note, tokens: tokens };
    });
  }

  function init() {
    var saved = readStored();
    apply(byId.has(saved) ? saved : CATALOG[0].id, { silent: true });
    return current;
  }

  window.Theme = {
    init: init,
    apply: apply,
    list: list,
    current: function () { return current; },
    // 换肤后要做的事（重绘 canvas、重建渐变……）挂这里
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    // 扩展方式：Theme.register({ id, name, note, tokens })。
    // tokens 只需给出想覆盖的令牌，其余继承当前主题的默认值。
    register: function (theme) {
      if (!theme || !theme.id || !theme.tokens) return false;
      var base = CATALOG[0].tokens;
      var merged = {};
      Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
      Object.keys(theme.tokens).forEach(function (k) { merged[k] = theme.tokens[k]; });
      var entry = { id: theme.id, name: theme.name || theme.id, note: theme.note || '', tokens: merged };
      var at = byId.get(entry.id);
      if (at) {
        at.tokens = merged; at.name = entry.name; at.note = entry.note;
      } else {
        CATALOG.push(entry);
        byId.set(entry.id, entry);
      }
      return true;
    }
  };
})();
