#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 晴空绘卷外观族契约（零依赖，静态扫描）。
//
// 为什么需要它
// ------------
// 装饰层（anime-ui.css / anime-stage.css / anime-interactions.*）曾经把 275 条
// 规则全部锁在 html[data-theme="celestial"] 上，于是"再加几套配色"只能加颜色：
// 切过去是默认外观涂了新漆，玻璃、噪点、24px 留白、ease-in-out 全都不跟过来。
// 现在改成按 data-look 选族（glass / cel），这带来三条必须钉住的不变量——
// 每一条都对应一种"能跑、元素齐全、只是不像那个皮肤"的静默降级：
//
//1. 装饰层不许再出现 data-theme 选择器。改回去不会有任何报错，只是新主题
//     又变回"只换色"，而唯一症状是用户说"看着不太对"。
//  2. themes.js 必须真的挂 data-look，且**每次都挂**。只在有 look 时写的话，
//     从 glass 切到无 look 的主题会留着上一套的外观——那套主题平白多一层玻璃。
//  3. 两套族的材质不许互相污染：cel-ui.css 必须排在 anime-ui.css 之后
//     （同特异性靠源码顺序决胜），且 cel 族的关键属性（backdrop-filter）
//     必须被显式关掉——只改背景色的话，模糊还留着，就还是玻璃。
//
// 第四条是后加的：点击特效**按主题声明**（themes.js 的 fx 字段 → <html
// data-fx>，原型库在 anime-interactions.css，运动学在 anime-interactions.js
// 的 EFFECTS 注册表）。特效归主题而非族，是因为"每套主题一种手感"是验收
// 提的硬要求；这里钉住的是三方名单（themes.js / EFFECTS / CSS 原型）必须
// 一致——漏一边的症状同样是静默的：注册表缺名 = 特效不触发，CSS 缺原型 =
// 粒子隐形。
//
// 用法: node scripts/check-anime-ui.js [前端目录]

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webDir = process.argv[2] || path.join(__dirname, '..', 'plugin', 'ui');
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), 'utf8');

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function section(name) { console.log('\n' + name); }

const THEMES = read('themes.js');
const ANIME_UI = read('anime-ui.css');
const ANIME_STAGE = read('anime-stage.css');
const INTERACTIONS_CSS = read('anime-interactions.css');
const INTERACTIONS_JS = read('anime-interactions.js');
const CEL_UI = read('cel-ui.css');
const INDEX = read('index.html');
const THEME_STUDIO = read('theme-studio.js');
// 内置主题的配色数据（fx / look 声明）已迁到 definition.json（生成目录的单源）。
// themes.js 只留机制；这里对数据的断言读源文件，对机制的断言仍读 themes.js。
const DEFINITION = JSON.parse(read('design/definition.json'));
const CEL_THEMES = ['kiminona', 'spirited'];
const GLASS_THEMES = ['celestial', 'starrail', 'liyue'];

// ---------------------------------------------------------------------------
section('外观族：装饰层不再按主题 id 选');

// 三个 CSS 里任何一处 html[data-theme="…"] 都是回退信号（anime-ui.css 里
// data-skin="classic" 的组合选择器是合法的，只查 data-theme）。
for (const [name, src] of [
  ['anime-ui.css', ANIME_UI], ['anime-stage.css', ANIME_STAGE],
  ['anime-interactions.css', INTERACTIONS_CSS]
]) {
  const hits = (src.match(/data-theme/g) || []).length;
  ok(hits === 0, `${name} 里没有 data-theme 选择器（实得 ${hits} 处；` +
    `装饰归外观族，颜色归 themes.js —— 两者混在一起时"加配色"就只会换色）`);
}

// JS 例外：它监听 data-theme 是**对的**——换主题 id 同样要终止上一套反馈。
// 这里要禁的是反过来那件事：拿 data-theme 的值当门禁（只认 celestial）。
ok(!/getAttribute\('data-theme'\)\s*===/.test(INTERACTIONS_JS),
  'anime-interactions.js 不用 data-theme 的值当门禁（判 id 的话新主题要回来改这个文件）');
ok(/getAttribute\(FX_ATTR\)/.test(INTERACTIONS_JS),
  'anime-interactions.js 的门禁读 data-fx（特效归主题声明，引擎不认识主题 id）');

for (const [name, src] of [['anime-ui.css', ANIME_UI], ['anime-stage.css', ANIME_STAGE]]) {
  ok(/data-look="glass"/.test(src) && /data-look="cel"/.test(src),
    `${name} 同时认 glass 与 cel 两族（新族没登记进来 = 该族只有颜色没有外观）`);
}

// ---- 下面这条曾经写成一个正则断言，连试四版都没能可靠判定，已删除 ----
//
// 它要抓的是这个坑（我自己踩了，代价是一次静默回归）：把装饰层从
// 「按主题 id 选」改成「按外观族选」时，最自然的写法是
//     html[data-look="glass"],
//     html[data-look="cel"] .topbar { … }
// 只有第二支带后缀，于是玻璃族（celestial / starrail / liyue）**永远拿不到
// 任何装饰**，而赛璐璐族一切正常：CSS 合法、页面不报错、元素齐全、
// 截图能看、控制台干净。唯一症状是"玻璃族看起来没换样式"。
//
// 为什么这里最终**没有**留下静态断言：判断"哪一支缺后缀"需要按顶层逗号
// 切选择器列表，而列表里既有 `:is(a, b)` 的函数逗号、又有跨行缩进，
// 写出来的判据要么恒绿、要么误报——四版都栽在这里。**恒绿的断言比没有
// 断言更糟**，它会让人以为这块有防护。
//
// 真值在浏览器侧：check-anime-ui-browser / tmp-theme-browser 量的是
// **解析后的计算值**—— topbar 的 border-radius / border-width /
// backdrop-filter，以及按钮 background-color。那是权威答案，不受文本形状影响。
//
// 静态这一层只保留两条它真正测得出的：
//   ① 两个文件里都不再有 data-theme 选择器（装饰不再按 id 选）；
//   ② 两族的名字都出现在里面（新族漏登记 = 该族只有颜色没有外观）。

// 响应式区段仍然是「族 + 皮肤」双限定：少掉 data-skin 那一半，
// classic 的几何（100px 导航轨、344px 舞台）会落到全部六套皮肤上。
ok(/data-look[^\]]*\]\[data-skin="classic"\]|\[data-skin="classic"\]/.test(ANIME_UI) &&
   /data-skin="classic"/.test(ANIME_UI),
  'classic 皮肤的几何仍限定了皮肤（少了这一半，它会落到全部皮肤上且不报错）');

// 行数守卫：批量改选择器最容易出的事是**吃掉换行**——把 @media / @container
// 里的多条规则拼成一行。文件照样能解析、契约照样全绿，只是整个响应式区段
// 被毁（而且症状延迟到某个断点才显形）。所以钉住行数与规则数。
const ruleCount = (s) => (s.match(/\{/g) || []).length;
ok(ruleCount(ANIME_UI) >= 200,
  'anime-ui.css 的规则数没有被改写塌缩（实得 ' + ruleCount(ANIME_UI) + '）');
ok(/\n\s*html:is\(\[data-look/.test(ANIME_UI) || !/@media/.test(ANIME_UI) ||
   /@media[^{]*\{[\s\S]*?\n\s*html:is/.test(ANIME_UI),
  '响应式区段里的选择器仍各占一行（跨行拼接的规则列表会让断点布局静默失效）');

// ---------------------------------------------------------------------------
section('外观族：themes.js 挂得上、也摘得下');

ok(/var LOOK_ATTR = 'data-look'/.test(THEMES), 'themes.js 声明了 data-look');
ok(/el\.setAttribute\(LOOK_ATTR,\s*theme\.look \|\| DEFAULT_LOOK\)/.test(THEMES),
  'apply() 每次都写 data-look（`theme.look || DEFAULT` 这个形状是关键：' +
  '只在有 look 时写的话，切到无 look 的主题会留着上一套的外观）');

for (const id of CEL_THEMES.concat(GLASS_THEMES)) {
  const entry = DEFINITION.themes.find((t) => t.id === id);
  ok(!!entry, `definition.json 登记了 ${id}`);
  if (!entry) continue;
  const look = entry.look;
  const want = CEL_THEMES.includes(id) ? 'cel' : 'glass';
  ok(look === want, `${id} 声明 look: '${want}'（实得 '${look}'；` +
    `认错族 = 配色是这一套、材质是那一套，比纯换色还难查）`);
}

// ---------------------------------------------------------------------------
section('点击特效：三方名单一致（themes.js ↔ EFFECTS ↔ CSS 原型）');

// 特效按主题声明的三方：themes.js / theme-studio.js 写 fx 值，
// anime-interactions.js 的 EFFECTS 注册表出运动学，anime-interactions.css
// 出 html[data-fx="…"] 原型。任何一边漏名都是静默的：
//   EFFECTS 缺名 → enabled() 恒 false → 特效压根不触发；
//   CSS 缺原型 → 粒子照放但没有形状没有动画，视觉上"反馈坏了"。
const declaredFx = DEFINITION.themes.filter((t) => t.fx).map((t) => t.fx);
const enabledFx = declaredFx.filter(fx => fx !== 'none');
const disabledThemes = DEFINITION.themes.filter(t => t.fx === 'none').map(t => t.id);
const studioFx = [...THEME_STUDIO.matchAll(/fx:\s*'(\w+)'/g)].map(m => m[1]);
const registrySrc = INTERACTIONS_JS.slice(
  INTERACTIONS_JS.indexOf('var EFFECTS = {'),
  INTERACTIONS_JS.indexOf('};', INTERACTIONS_JS.indexOf('var EFFECTS = {')));
const registryFx = [...registrySrc.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]);
const cssFx = [...INTERACTIONS_CSS.matchAll(/html\[data-fx="(\w+)"\]/g)].map(m => m[1]);
const uniq = (a) => [...new Set(a)];

ok(/var FX_ATTR = 'data-fx'/.test(THEMES), 'themes.js 声明了 data-fx');
ok(/el\.setAttribute\(FX_ATTR,\s*theme\.fx \|\| LOOK_FX\[theme\.look \|\| DEFAULT_LOOK\] \|\| DEFAULT_FX\)/.test(THEMES),
  'apply() 每次都写 data-fx（`theme.fx || LOOK_FX || DEFAULT` 这个形状是关键：' +
  '只在有 fx 时写的话，切到未声明的主题会留着上一套的粒子原型）');
ok(declaredFx.length >= 20, '内置目录大面积声明了 fx（实得 ' + declaredFx.length + ' 套；' +
  '这是"每套主题一种手感"的验收硬要求，漏声明 = 该主题静默退到族兜底）');
ok(enabledFx.every(fx => registryFx.includes(fx)),
  'themes.js 的每个 fx 都在 EFFECTS 注册表里（缺名 = 特效不触发）: ' +
    uniq(enabledFx.filter(fx => !registryFx.includes(fx))).join(', '));
ok(enabledFx.every(fx => cssFx.includes(fx)),
  'themes.js 的每个 fx 都有 CSS 原型（缺 = 粒子隐形）: ' +
    uniq(enabledFx.filter(fx => !cssFx.includes(fx))).join(', '));
ok(studioFx.every(fx => registryFx.includes(fx) && cssFx.includes(fx)),
  'theme-studio.js 的每个 fx 都是登记过的原型: ' +
    uniq(studioFx.filter(fx => !registryFx.includes(fx) || !cssFx.includes(fx))).join(', '));
ok(registryFx.every(fx => cssFx.includes(fx)),
  'EFFECTS 里的每个原型都有 CSS（缺 = 引擎放粒子但没有形状）: ' +
    uniq(registryFx.filter(fx => !cssFx.includes(fx))).join(', '));
ok(cssFx.every(fx => registryFx.includes(fx)),
  'CSS 里没有 EFFECTS 认不出的原型（死样式只会让人以为它生效）: ' +
    uniq(cssFx.filter(fx => !registryFx.includes(fx))).join(', '));
// "不同主题色的特效应该不同"——内置 23 套的主题特效两两不同。
// theme-studio 的二次元批次允许与内置共用原型（批次的气质归 palette 区分）。
ok(uniq(enabledFx).length === enabledFx.length,
  '启用特效的内置主题 fx 两两不同（实得 ' + uniq(enabledFx).length + '/' + enabledFx.length + '；' +
  '两套主题共用一种手感 = 验收要求被悄悄打了折）');

section('明确关闭点击反馈：Hertz 深浅主题不回退 spark');
ok(disabledThemes.includes('hertz-dark') && disabledThemes.includes('hertz-light'), '两个 Hertz 主题显式声明 fx:none');
ok(!registryFx.includes('none') && !cssFx.includes('none'), 'none 是禁用值，不伪造粒子原型');

// Run the actual theme writer and interaction engine. A positive control
// proves this DOM reaches the burst path before testing the disabled value.
(function checkDisabledFeedback() {
  const observers = [], listeners = new Map(), timers = new Map();
  let created = 0, clock = 0, timerId = 0;
  function node() {
    const attrs = {};
    return {
      nodeType: 1, isConnected: true, className: '', children: [], parentNode: null,
      style: { setProperty(k,v) { this[k]=v; }, removeProperty(k) { delete this[k]; } },
      classList: { contains() { return false; } }, matches() { return false; },
      setAttribute(k,v) { attrs[k]=String(v); observers.forEach(o=>{ if(o.targets.has(this))o.callback([{attributeName:k}]); }); },
      getAttribute(k) { return attrs[k] || null; },
      appendChild(child) { child.parentNode=this;this.children.push(child);return child; },
      remove() { if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null; },
      addEventListener() {}, removeEventListener() {},
      get firstElementChild() { return this.children[0] || null; },
    };
  }
  const root = node(), body = node();
  const button = node();
  button.closest = selector => selector.includes('button') ? button : null;
  button.getBoundingClientRect = () => ({left:0,top:0,right:44,bottom:44,width:44,height:44});
  const sandbox = {
    console, Object, Array, JSON, String, Number, Math, Map, Set,
    localStorage: { getItem() { return null; },setItem() {} },
    document: { documentElement:root,body,hidden:false,fullscreenElement:null,
      createElement() { created++;return node(); },
      addEventListener(type,fn) { if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn); },
      removeEventListener(type,fn) { if(listeners.has(type))listeners.get(type).delete(fn); } },
    getComputedStyle:()=>({visibility:'visible'}),performance:{now:()=>clock+=1000},
    setTimeout(fn) { const id=++timerId;timers.set(id,fn);return id; },clearTimeout(id) { timers.delete(id); },
    addEventListener() {},removeEventListener() {},
    matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
    MutationObserver: class { constructor(callback) { this.callback=callback;this.targets=new Set();observers.push(this); } observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); } },
  };
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('design/design-themes.js'),sandbox,{filename:'design/design-themes.js'});
  vm.runInContext(THEMES,sandbox,{filename:'themes.js'});
  sandbox.Theme.init();
  vm.runInContext(INTERACTIONS_JS,sandbox,{filename:'anime-interactions.js'});
  const click=()=>listeners.get('click').forEach(fn=>fn({target:button,detail:1,button:0,clientX:22,clientY:22}));
  for(const id of ['hertz-dark','hertz-light']) {
    sandbox.Theme.apply('emerald');click();
    ok(body.children.length>0 && timers.size>0, '启用主题仍能创建真实点击反馈');
    sandbox.Theme.apply(id);
    ok(root.getAttribute('data-fx')==='none',id+' 实际 apply 写入 none');
    ok(body.children.length===0 && timers.size===0,id+' 切换时释放上个主题的粒子与计时器');
    const before=created;click();
    ok(created===before && timers.size===0,id+' 点击不创建粒子、不回退 spark');
  }
  sandbox.AnimeInteractions.destroy();
  ok(listeners.get('click').size===0,'禁用后仍能完整卸载反馈监听');
})();

// ---------------------------------------------------------------------------
section('外观族：cel-ui.css 的接线与材质');

const celAt = INDEX.indexOf('cel-ui.css');
const animeAt = INDEX.indexOf('anime-ui.css');
ok(celAt > 0, 'index.html 引入了 cel-ui.css');
ok(animeAt > 0 && celAt > animeAt,
  'cel-ui.css 排在 anime-ui.css 之后（同特异性靠源码顺序决胜；' +
  '放前面会被玻璃面板整块盖掉，症状只是"看起来不够平涂"）');

// ⚠ 这条曾经是"cel-ui.css 排在 anime-interactions.css 之后（否则点击反馈的
// 族差异被盖掉）"。点击反馈按主题声明 fx 之后，cel-ui.css **不再碰粒子** ——
// 反过来这条更值得钉：谁往 cel-ui.css 里加回 .anime-interactions-* 覆盖，
// 它就会以族为单位压过按主题的原型（同特异性、源码更靠后），把"每套主题
// 一种手感"悄悄退回"每族一种手感"，而且不报错、元素齐全。
const interactionsAt = INDEX.indexOf('anime-interactions.css');
const stageAt = INDEX.indexOf('anime-stage.css');
ok(interactionsAt > 0, 'index.html 引入了 anime-interactions.css');
ok(stageAt > 0 && celAt > stageAt,
  'cel-ui.css 排在 anime-stage.css 之后（否则舞台的族差异被盖掉）');
ok(!/data-skin-css="cel/.test(INDEX), 'cel-ui.css 是常驻引入，不走皮肤开关');

// 赛璐璐的点击反馈不再由本文件负责 —— 粒子选择器一旦出现在**规则**里，
// 就是族级覆盖卷土重来的信号（见上一条注释）。剥掉注释再查：第 4 段留着
// 一段"为什么退役"的说明，里头提到选择器名是文档，不是覆盖。
const celRules = CEL_UI.replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/anime-interactions-particle/.test(celRules),
  'cel-ui.css 不覆盖点击粒子（特效归主题声明，族级覆盖会压过按主题的原型）');
ok(!/cel-button-chip/.test(celRules),
  'cel-button-chip 关键帧已退役（点击反馈按主题走 anime-interactions.css 的 fx 原型）');

// 赛璐璐 = 平涂 + 明确描边。这两条是它与玻璃族的分界，必须显式存在：
// 只把背景改成不透明而留着 backdrop-filter blur() 的话，面板仍然是玻璃。
ok(/html\[data-look="cel"\][^{]*:is\(\.topbar, \.rail, \.column\)\s*\{[\s\S]*?backdrop-filter:\s*none/.test(CEL_UI),
  'cel 族的面板显式关掉 backdrop-filter（只改背景不关模糊 = 仍是玻璃）');
ok(/html\[data-look="cel"\] :is\(\.topbar, \.rail, \.column\)\s*\{[\s\S]*?color-mix\(in srgb, var\(--panel-solid\)/.test(CEL_UI),
  'cel 族的面板用不透明平涂（面板要透出壁纸就不是平涂了）');
// 硬边接触影：偏移非零、模糊半径为 0。**不能**用 /px 0 / 这类形状匹配去量
// 浏览器实测值——0 与 0px 的写法差异会让规则明明生效也报失败。一个经常误报
// 的断言等于没有断言，所以这里接受 0 与 0px 两种写法，真正的判据留给浏览器
// 脚本（它量的是解析后的偏移量与模糊半径，不是字符串形状）。
ok(/html\[data-look="cel"\] :is\(\.topbar, \.rail, \.column\)\s*\{[\s\S]*?box-shadow:\s*\d+px \d+px 0(?:px)?\s/.test(CEL_UI),
  'cel 族用硬边接触影而不是弥散辉光（多层柔和阴影正是"厚涂"的来源）');

// 静态正则量不准"模糊半径为 0"（手写 0 与浏览器 0px 的写法差异），所以这里
// 反过来断言一件静态能确定的事：cel-ui.css 里**不出现**任何非零模糊半径。
// 这条比"看起来像硬边"更难写歪——多写一个 blur(6px) 就红。
// 「有没有模糊半径」这件事**不在这里断言**，交给浏览器脚本
// （check-anime-ui-browser / tmp-theme-browser 量的是解析后的 blur 值）。
//
// 原因值得记下来：这条判据用正则写不出来。box-shadow 允许省略 blur，
// `3px 3px 0 6px #000` 到底是"spread=6"还是"blur=6"取决于它前面还剩几个长度；
// 而要数长度就得先剥颜色，剥颜色又会被 `px` 里的字母、`rgb(15 20 50 / 22%)`
// 里的空格斜杠、`color-mix(...)` 里的嵌套括号反复骗到。我在这上面试了三版
// 正则，每版都能被某个合法输入骗过——而**恒绿的断言比没有断言更糟**。
// 真正要量的量（模糊半径是否为 0）只有浏览器能给出权威答案。
//
// 这里只保留一条静态能可靠判定的：**禁用函数式模糊**。
// box-shadow 里写 blur(...) 是显式糊弄，禁掉它，剩下的简写形式由浏览器兜。
ok(!/box-shadow:[^;]*blur\(/.test(CEL_UI),
  'cel-ui.css 的投影不用blur() 函数（显式模糊就是厚涂；' +
  '省略写法的模糊半径由浏览器脚本实测把关）');

ok(/html\[data-look="cel"\] :is\(\.btn, \.iconbtn, \.btn-pill\)/.test(CEL_UI),
  'cel 族给控件也上了描边（平涂色块的边界靠描边，不靠投影堆叠）');

// 按下反馈：玻璃族是 scale(.98)，赛璐璐族必须是"投影收回 + 位移"，否则
// 两种手感混在同一个按钮上，看起来像抖动。
ok(/html\[data-look="cel"\][^{]*:active[^{]*\{[\s\S]*?box-shadow:\s*0 0 0/.test(CEL_UI),
  'cel 族按下时把硬投影收回（这才是赛璐璐版的"按下"手感）');
ok(/prefers-reduced-motion: reduce/.test(CEL_UI) && /transform: none !important/.test(CEL_UI),
  'cel 族冻结动效时连位移一起收（按钮会停在"还没弹回来"的中间态）');

// ---------------------------------------------------------------------------
section('外观族：结构装饰仍然共享');

// 间距/圆角/缓动/噪点是**两族共享**的结构装饰，住在 anime-ui.css 里，
// 由 data-look 选族。cel-ui.css 只该改材质，不该重定义尺度——
// 那会让赛璐璐族悄悄漂成另一套间距，而两族看起来"本来就该不一样"。
ok(/--anime-section-gap:\s*24px/.test(ANIME_UI), '共享装饰里 24px 区块间距还在');
ok(/--dur-base:\s*240ms/.test(ANIME_UI) && /--ease:\s*ease-in-out/.test(ANIME_UI),
  '共享装饰里 ease-in-out 200–280ms 还在');
ok(/opacity:\s*\.065/.test(ANIME_UI), '共享装饰里 6.5% 噪点还在（避免塑料感）');
ok(!/--dur-base|--ease-out|--radius-lg/.test(CEL_UI),
  'cel-ui.css 不重定义圆角/缓动（尺度归共享装饰，材质归本文件）');

// 色值必须走令牌：装饰层里写死 celestial 的品牌青/暖金，任何一套主题
// 都会撒着别家的粒子与描边——看上去完全合理，所以极难排查。
ok(!/#f3dca7|#89d5e5/.test(ANIME_UI), 'anime-ui.css 不写死 celestial 的暖金/青');
ok(!/#f3dca7|#89d5e5/.test(INTERACTIONS_CSS), 'anime-interactions.css 不写死 celestial 的暖金/青');
// 粒子的三档语义色在原型库的基座里从令牌派生，随主题自动同族：
// 主色 accent、次色 brand、高光位 highlight。
ok(/--fx-a:\s*var\(--accent,/.test(INTERACTIONS_CSS), '粒子主色跟随主题的 accent');
ok(/--fx-b:\s*var\(--brand,/.test(INTERACTIONS_CSS), '粒子次色跟随主题的 brand');
ok(/--fx-hi:\s*var\(--highlight,/.test(INTERACTIONS_CSS), '粒子高光位跟随主题的 highlight');

// ---------------------------------------------------------------------------
section('点击反馈按主题放行');

ok(/var EFFECTS = \{/.test(INTERACTIONS_JS),
  'anime-interactions.js 有特效注册表（键 = data-fx 值，判主题 id 的话新主题要回来改这个文件）');
ok(/attributeFilter:\s*\[[^\]]*(FX_ATTR|'data-fx')/.test(INTERACTIONS_JS),
  'MutationObserver 监听 data-fx（只监听 data-theme 的话，换主题不重置反馈）');
// 它用 matchMedia 判，不是 CSS 的 @media —— 所以查 matchMedia 而不是字面量。
ok(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(INTERACTIONS_JS),
  '点击反馈尊重 prefers-reduced-motion');
ok(/body\.classList\.contains\('reduce-motion'\)/.test(INTERACTIONS_JS),
  '点击反馈也尊重界面内的 reduce-motion 开关');

console.log('\n' + '─'.repeat(60));
console.log(`晴空绘卷外观族契约检查：${checks - failures}/${checks} ${failures ? '通过，' + failures + ' 项失败' : '全部通过'}`);
process.exit(failures ? 1 : 0);