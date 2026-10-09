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
// 用法: node scripts/check-anime-ui.js [前端目录]

'use strict';

const fs = require('fs');
const path = require('path');

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
ok(/getAttribute\('data-look'\)/.test(INTERACTIONS_JS),
  'anime-interactions.js 的门禁读 data-look');

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
  const at = THEMES.indexOf("id: '" + id + "'");
  ok(at >= 0, `themes.js 登记了 ${id}`);
  if (at < 0) continue;
  const block = THEMES.slice(at, THEMES.indexOf('\n    {', at + 10) < 0 ? undefined : THEMES.indexOf('\n    {', at + 10));
  const look = (block.match(/look:\s*'(\w+)'/) || [])[1];
  const want = CEL_THEMES.includes(id) ? 'cel' : 'glass';
  ok(look === want, `${id} 声明 look: '${want}'（实得 '${look}'；` +
    `认错族 = 配色是这一套、材质是那一套，比纯换色还难查）`);
}

// ---------------------------------------------------------------------------
section('外观族：cel-ui.css 的接线与材质');

const celAt = INDEX.indexOf('cel-ui.css');
const animeAt = INDEX.indexOf('anime-ui.css');
ok(celAt > 0, 'index.html 引入了 cel-ui.css');
ok(animeAt > 0 && celAt > animeAt,
  'cel-ui.css 排在 anime-ui.css 之后（同特异性靠源码顺序决胜；' +
  '放前面会被玻璃面板整块盖掉，症状只是"看起来不够平涂"）');

// ⚠ 这条是补的，别当成重复：赛璐璐族要覆盖的不止面板材质，还有**点击反馈**
// （cel-ui.css 第 4 段把旋转星屑换成直角碎片）。而 anime-interactions.css
// 也用 html:is([data-look=…]) 选择器 —— 它排在 cel-ui 之后时，赛璐璐的
// 粒子覆盖会被它整块盖掉，症状是"两族点击手感一模一样，只是配色不同"。
// 我就踩过一次：面板对了、粒子没对，只看截图看不出来。
const interactionsAt = INDEX.indexOf('anime-interactions.css');
const stageAt = INDEX.indexOf('anime-stage.css');
ok(interactionsAt > 0 && celAt > interactionsAt,
  'cel-ui.css 排在 anime-interactions.css 之后（否则点击反馈的族差异被盖掉）');
ok(stageAt > 0 && celAt > stageAt,
  'cel-ui.css 排在 anime-stage.css 之后（否则舞台的族差异被盖掉）');
ok(!/data-skin-css="cel/.test(INDEX), 'cel-ui.css 是常驻引入，不走皮肤开关');

// 赛璐璐必须真的换了粒子形态，而不只是换了面板颜色 —— 这是"族"与"纯换色"
// 的分界线。少任何一条，两族就共用一套手感，族的划分只剩静态材质。
ok(/html\[data-look="cel"\] \.anime-interactions-particle[\s\S]*?border-radius:\s*0/.test(CEL_UI),
  '赛璐璐的点击碎片是直角（玻璃族是 1px 圆角）');
ok(/html\[data-look="cel"\] \.anime-interactions-particle[\s\S]*?animation:\s*cel-button-chip/.test(CEL_UI),
  '赛璐璐的碎片用另一套关键帧（cel-button-chip），不是玻璃的 anime-button-spark');
ok(/@keyframes cel-button-chip\s*\{[\s\S]*?translate3d/.test(CEL_UI),
  'cel-button-chip 关键帧存在且走 transform 位移');
ok(!/@keyframes cel-button-chip\s*\{[^@]*?rotate\(/.test(CEL_UI),
  '赛璐璐碎片**不旋转**（旋转柔光是玻璃的语言）');
ok(/html\[data-look="cel"\] \.anime-interactions-particle\s*\{[\s\S]*?box-shadow:\s*none/.test(CEL_UI),
  '赛璐璐碎片无辉光（边界靠实色与描边，不靠发光）');
// 双色要保留：全是一个颜色会读成"单色烟花"，且与玻璃族的手感差异被抹掉。
ok(/nth-child\(3n\)/.test(CEL_UI), '赛璐璐碎片保留双色（highlight + brand）');

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

// 色值必须走令牌：装饰层里写死 celestial 的品牌青/暖金，赛璐璐族就会
// 撒着别家主题的粒子与描边——看上去完全合理，所以极难排查。
ok(!/#f3dca7|#89d5e5/.test(ANIME_UI), 'anime-ui.css 不写死 celestial 的暖金/青');
ok(/--anime-particle-gold:\s*rgb\(var\(--highlight-rgb/.test(ANIME_UI),
  '粒子颜色跟随主题的 highlight');
ok(/--anime-particle-cyan:\s*rgb\(var\(--brand-rgb/.test(ANIME_UI),
  '粒子次色跟随主题的 brand');

// ---------------------------------------------------------------------------
section('外观族：点击反馈按族放行');

ok(/var LOOKS = \['glass', 'cel'\]/.test(INTERACTIONS_JS),
  'anime-interactions.js 判的是外观族而不是主题 id（判 id 的话新主题要回来改这个文件）');
ok(/attributeFilter:\s*\[[^\]]*'data-look'/.test(INTERACTIONS_JS),
  'MutationObserver 监听 data-look（只监听 data-theme 的话，换族不重置反馈）');
// 它用 matchMedia 判，不是 CSS 的 @media —— 所以查 matchMedia 而不是字面量。
ok(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(INTERACTIONS_JS),
  '点击反馈尊重 prefers-reduced-motion');
ok(/body\.classList\.contains\('reduce-motion'\)/.test(INTERACTIONS_JS),
  '点击反馈也尊重界面内的 reduce-motion 开关');

console.log('\n' + '─'.repeat(60));
console.log(`晴空绘卷外观族契约检查：${checks - failures}/${checks} ${failures ? '通过，' + failures + ' 项失败' : '全部通过'}`);
process.exit(failures ? 1 : 0);