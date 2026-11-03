// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 多主题色：把参考项目已有的一批主题配色映射到本项目的令牌上。
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

  // 默认外观可以更新，已经保存的主题（包括稍后注册的主题）继续按原选择恢复。
  // 唯一的例外是旧默认值本身：它会被一次性换到新默认，见 migrateDefault()。
  var STORE_KEY = 'vmusic.theme.v2';
  var ATTR = 'data-theme';
  var DEFAULT_ID = 'mineral';
  // 默认档从「晴空绘卷」换成「矿石黑」。旧默认值要走一次性迁移，
  // 理由见 migrateDefault()。
  var PREVIOUS_DEFAULT_ID = 'celestial';
  var DEFAULT_MIGRATED_KEY = 'vmusic.theme.mineral-default';
  // 外观族：颜色归主题，材质/圆角/间距/动效归外观。
  //
  // 为什么需要它：装饰层（anime-ui.css / anime-stage.css / anime-interactions.*）
  // 曾经把 275 条规则全部锁在 html[data-theme="celestial"] 上，于是"再加几套配色"
  // 只能加颜色——切过去是默认外观涂了新漆，玻璃、噪点、24px 留白、ease-in-out
  // 全部不跟过来。这跟项目里「主题只管颜色」的规矩并不矛盾：规矩说的是
  // **令牌表里不许出现尺度**，不是"每个颜色值都得重写一遍装饰"。
  //
  // 现在同一套装饰由 data-look 选族：
  //   glass —— 半透明毛玻璃 + 暖白高光 + 蓝紫阴影（晴空绘卷 / 星穹铁道 / 璃月）
  //   cel   —— 赛璐璐：平涂不透明色块 + 深色明确描边，无模糊（你的名字 / 千与千寻）
  // 两族共享同一份结构装饰（间距、圆角、缓动、噪点），只在材质层分叉。
  var LOOK_ATTR = 'data-look';
  var DEFAULT_LOOK = 'plain';
  // 点击特效归主题自己声明（fx 字段，如 'stardust' / 'ember'），落到
  // <html data-fx> 上由 anime-interactions.* 选原型。特效的形状与动效跟着
  // 主题的气质走，颜色仍走令牌（--accent / --brand / --highlight），所以
  // 自定义配色不声明 fx 也有得看。
  var FX_ATTR = 'data-fx';
  // 没声明 fx 的主题按外观族兜底：族原有的手感保留（glass=星屑、cel=碎片），
  // 其余走中性光点。声明了 fx 的一律以声明为准。
  var DEFAULT_FX = 'spark';
  var LOOK_FX = { glass: 'stardust', cel: 'shard' };

  // -------------------------------------------------------------------------
  // 内置主题目录
  //
  // 配色数据由 design/definition.json 单源生成（design/design-themes.js，生成物
  // 禁止手改）：themes.js 只保留登记、应用、恢复与派生的机制。加主题 =
  // 编辑 definition.json 后重新生成（node scripts/generate-design.js）。
  // -------------------------------------------------------------------------
  var CATALOG = (function () {
    var data = window.__HERTZ_DESIGN_THEMES;
    if (!data || !data.length) {
      // 目录缺失 = 生成物没随包发布（正常发布不可能发生：check-assets 钉住
      // index.html 与 assets.rs 的成对登记）。不在这里放第二份硬编码兜底——
      // 那等于重新制造"默认值副本"这个本次收敛要退役的东西。喊出原因，
      // 让症状可查而不是静默回退。
      if (window.console && console.error) console.error('design/design-themes.js 未加载：主题目录为空');
      return [];
    }
    return data.map(function (entry) {
      return {
        id: entry.id,
        name: entry.name,
        note: entry.note || '',
        tokens: Object.assign({}, entry.tokens),
        // look / fx 保持原样（可缺省）：apply() 的族与特效兜底逻辑照旧生效。
        look: entry.look,
        fx: entry.fx,
      };
    });
  })();

  var byId = new Map();
  CATALOG.forEach(function (t) { byId.set(t.id, t); });

  var current = null;
  var listeners = [];
  /// 启动时想要、但那一刻还没登记进目录的主题 id。
  ///
  /// 目录不是一次性给出的：内置主题在这里，而二次元那七套与「自定义配色」由
  /// ThemeStudio 在启动后半程 register 进来。于是用户选了后者时，存储的 id 在
  /// init() 读回来的瞬间还不认识——就地兜底就等于"刷新后选择丢了"。这里把它
  /// 记下来，等那套主题登记完成的那一刻再兑现（见 register）。
  var pendingId = null;

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
    var theme = byId.get(id) || byId.get(DEFAULT_ID);
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
    //
    // accent-2 同样要派生：舞台的第二支高亮色吃它。它与 accent 必须**不同**
    // —— 两者相同时频谱柱全染成一种颜色，加性混合一叠就是一块实心白。
    // 只派生不校验的话，某个主题若没给 --accent-2 就会悄悄退回全局默认青，
    // 在那个主题下重新变成单色。
    //
    // --text / --bg 也要派生：外观层（cel-ui.css 的描边、anime-ui.css 里
    // 从"暖白高光"反推的半透明叠层）需要在 rgba() 里用它们的三元组。少了这两份，
    // 那层就只能写死颜色字面量，于是又变成"只有 celestial 有这个效果"。
    ['--accent', '--accent-2', '--text', '--bg'].forEach(function (key) {
      var hex = theme.tokens[key];
      if (!hex || !/^#([0-9a-f]{6})$/i.test(hex)) {
        // 派生不出来就**清掉**：否则切到没给这个色的主题（例如只声明了
        // accent 的扩展主题）时，上一套的 rgb 三元组会留在 <html> 上，
        // 外观层拿它去rgba() 出来的颜色看着完全合理——于是"换皮没换干净"
        // 这类bug 没有任何症状可查。
        el.style.removeProperty(key + '-rgb');
        return;
      }
      var n = parseInt(hex.slice(1), 16);
      el.style.setProperty(key + '-rgb',
        [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', '));
    });
    // 老主题里没有 --brand / --highlight 这两个角色色：这里按 accent / accent-2
    // 派生一份，保证统一组件层（激活态/焦点环/选中态）在任何主题下都有值，
    // 不会因为换肤而退化成空白描边。
    ['--brand', '--brand-rgb', '--highlight', '--highlight-rgb'].forEach(function (k) {
      if (theme.tokens[k]) return;
      var primary = theme.tokens['--accent'];
      var secondary = theme.tokens['--accent-2'] || primary;
      if (k === '--brand') el.style.setProperty(k, secondary);
      else if (k === '--highlight') el.style.setProperty(k, primary);
      else {
        var hex = k === '--brand-rgb' ? secondary : primary;
        if (hex && /^#([0-9a-f]{6})$/i.test(hex)) {
          var m = parseInt(hex.slice(1), 16);
          el.style.setProperty(k, [(m >> 16) & 255, (m >> 8) & 255, m & 255].join(', '));
        }
      }
    });
    el.setAttribute(ATTR, theme.id);
    // 外观族选择器。**必须每次都写**：从 glass 族切到没有 look 的主题
    // （内置里那些纯换色的）时，若只在有 look 时才 setAttribute，上一套的
    // data-look 会留在 <html> 上，那套主题于是平白多出一层玻璃装饰。
    el.setAttribute(LOOK_ATTR, theme.look || DEFAULT_LOOK);
    // 点击特效与 data-look 同一条纪律：**必须每次都写**，否则从有特效的
    // 主题切到没有特效声明的主题时，上一套的 data-fx 会留在 <html> 上，
    // 那套主题于是放着别家的粒子。
    el.setAttribute(FX_ATTR, theme.fx || LOOK_FX[theme.look || DEFAULT_LOOK] || DEFAULT_FX);
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
  // 这里是拷贝，外部改不动 CATALOG。look 一并带出去，菜单才能标出「这套
  // 自带外观」，也让契约脚本读得到族归属。
  function list() {
    var ordered = CATALOG.filter(function (t) { return t.id === DEFAULT_ID; })
      .concat(CATALOG.filter(function (t) { return t.id !== DEFAULT_ID; }));
    return ordered.map(function (t) {
      var tokens = {};
      Object.keys(t.tokens).forEach(function (k) { tokens[k] = t.tokens[k]; });
      return {
        id: t.id, name: t.name, note: t.note, tokens: tokens,
        look: t.look || DEFAULT_LOOK,
        fx: t.fx || LOOK_FX[t.look || DEFAULT_LOOK] || DEFAULT_FX
      };
    });
  }

  function init() {
    var saved = migrateDefault(readStored());
    if (byId.has(saved)) {
      apply(saved, { silent: true });
      return current;
    }
    // 不认识未必是数据坏了，也可能是这套主题还没登记上来（见 pendingId）。
    // 注意这里不能回写：存储里那个 id 可能晚一步就变得有效了，抹掉它就真的丢了。
    pendingId = saved || null;
    apply(DEFAULT_ID, { silent: true });
    return current;
  }

  // 默认档从「晴空绘卷」换成「矿石黑」，需要动一次已存的旧值。
  //
  // 与歌单排布那次同一形状的问题：旧默认在菜单里就叫「晴空绘卷（默认）」，
  // 点它和「没选过」在存储里长得一样。这里只动那个分不出来的值——存的是
  // 其它主题（含后来登记的二次元批次与自定义配色）一律原样恢复；标记落定后
  // 用户再主动选晴空绘卷，也不会被改回去。
  function migrateDefault(saved) {
    if (saved !== PREVIOUS_DEFAULT_ID) return saved;
    try {
      if (localStorage.getItem(DEFAULT_MIGRATED_KEY)) return saved;
      localStorage.setItem(DEFAULT_MIGRATED_KEY, '1');
      localStorage.setItem(STORE_KEY, DEFAULT_ID);
    } catch (e) { /* 隐私模式：写不进标记，这次就当没迁移过 */ }
    return DEFAULT_ID;
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
      // 部分声明的扩展主题沿用稳定的基础令牌，不继承新默认外观的专属玻璃表面。
      var base = CATALOG[0].tokens;
      var merged = {};
      Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
      Object.keys(theme.tokens).forEach(function (k) { merged[k] = theme.tokens[k]; });
      var entry = { id: theme.id, name: theme.name || theme.id, note: theme.note || '', tokens: merged };
      // look 是**主题自己的属性**，不进 tokens（那是令牌表，只许有颜色）。
      // 不继承已有条目：register 用于"就地改写"同一 id 时，改的正是配色，
      // 外观族得由调用方显式声明；沿用旧值会把上一套的外观悄悄留给新配色。
      entry.look = theme.look || DEFAULT_LOOK;
      // fx 与 look 同一条规矩：主题自己的属性，不进 tokens，也不继承旧条目——
      // register 用于"就地改写"同一 id 时，调用方不声明就不该沿用上一套特效。
      entry.fx = theme.fx || LOOK_FX[entry.look] || DEFAULT_FX;
      var at = byId.get(entry.id);
      if (at) {
        at.tokens = merged; at.name = entry.name; at.note = entry.note;
        at.look = entry.look; at.fx = entry.fx;
      } else {
        CATALOG.push(entry);
        byId.set(entry.id, entry);
      }
      // 延迟兑现：之前存着的选择正是这套主题，现在它终于存在于目录里了。
      // 用 silent 是因为存储已经是这个值，写回去只是重复；这一趟的目的是让
      // 令牌真的落到 <html> 上，并把「主题变了」广播给已经订阅的人。
      if (pendingId === entry.id) {
        pendingId = null;
        apply(entry.id, { silent: true });
      }
      return true;
    }
  };
})();
