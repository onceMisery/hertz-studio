#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// 舞台主题契约检查（零依赖、不触网）。
//
//   node scripts/check-stage-theme.js
//
// 舞台主题与皮肤是**两个正交维度**：皮肤换整个应用的布局、彼此互斥；
// 舞台主题只换沉浸舞台操作层的观感，与任意皮肤可组合。最容易坏的四个地方
// 各钉一条：
//
//   1. **偷偷改配色**。主题 CSS 里出现颜色字面量，就会绕过舞台自己的令牌。
//   2. **越界**。主题只许落在 .s3d 子树；碰 SPA 模块或碰皮肤选择器都会
//      让两个维度互相污染。
//   3. **与皮肤混淆**。星落不许出现在 Skins 目录里，皮肤也不许引用舞台主题。
//   4. **静默丢弃**。选择器列表里混用 ::-webkit- 与 ::-moz- 私有伪元素，
//      整条规则会被浏览器丢掉，页面上看不出来。
//
// 另外把「沉浸」的两条硬行为也钉住：静止时歌单架收起、播放舱收起。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const THEME = read(path.join(WEB, 'stage-themes', 'starfall.css'));
const STAGE3D_CSS = read(path.join(WEB, 'stage3d.css'));
const STAGE3D_JS = read(path.join(WEB, 'stage3d.js'));
const SKINS_JS = read(path.join(WEB, 'skins', 'skins.js'));
const HTML = read(path.join(WEB, 'index.html'));
const MAIN_RS = read(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'assets.rs'));
const WORKSHOP = read(path.join(WEB, 'workshop.js'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function section(name) { console.log('\n' + name); }

const body = THEME.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// 1. 配色纪律
// ---------------------------------------------------------------------------

section('舞台主题只管观感：CSS 里不许有颜色字面量');

const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
const rgb = body.match(/\brgba?\(/g) || [];
const named = body.replace(/white-space|grey|gray/g, '')
  .match(/\b(?:red|blue|green|white|black)\b/g) || [];
ok(hex.length === 0, `starfall 没有十六进制颜色${hex.length ? '（' + hex.join(',') + '）' : ''}`);
ok(rgb.length === 0, 'starfall 没有 rgb()/rgba()');
ok(named.length === 0, `starfall 没有颜色关键字${named.length ? '（' + named.join(',') + '）' : ''}`);
const colors = Array.from(body.matchAll(/(?:^|[\s;}])color\s*:\s*([^;}]+)/g));
const badColor = colors.filter((m) => !/^\s*var\(--/.test(m[1]));
ok(badColor.length === 0,
  `starfall 的 color 只能引用令牌${badColor.length ? '（' + badColor.map((m) => m[1].trim()).join(',') + '）' : ''}`);
ok(colors.length >= 2, 'starfall 确有着色（不是纯几何皮肤）');
ok(!/^\s*(--bg|--text|--accent|--muted|--brand|--highlight)\s*:/m.test(body),
  'starfall 不重定义应用主题色变量');
ok(!/^\s*--s3d-(bg|text|muted|accent)\s*:/m.test(body),
  'starfall 不重定义舞台令牌（只消费，不篡改）');
ok(/\bcolor-mix\(in srgb, var\(--s3d-/.test(body), '玻璃材质由舞台令牌经 color-mix 派生');

// ---------------------------------------------------------------------------
// 2. 作用域：只落在 .s3d 子树
// ---------------------------------------------------------------------------

section('作用域：每条规则都在 [data-stage-theme] 与 .s3d 之内');

// 属性写在 .s3d 自身上（舞台根节点），所以每条规则都必须以
// `.s3d[data-stage-theme="starfall"]` 开头：漏了前缀就关不掉，漏了 .s3d 就会
// 染到舞台外面。捕获前缀之后的部分，用来检查它碰了哪些模块。
const PREFIX = '.s3d[data-stage-theme="starfall"]';

function selectorsOf(css) {
  const out = new Set();
  const re = new RegExp('\\.s3d\\[data-stage-theme="[a-z]+"\\]([^{@]*)\\{', 'g');
  let m;
  while ((m = re.exec(css))) {
    m[1].split(',').forEach((part) => {
      const s = part.trim();
      if (s) out.add(s);
    });
  }
  return out;
}

// 行首排除 }/@/空白/from/to，避免把上一条规则的右花括号、@media 头或
// 关键帧的 from/to 误当成选择器开头。
const allRuleSelectors = Array.from(body.matchAll(/^([^\s@/}][^{]*)\{/gm))
  .map((m) => m[1].trim())
  .filter((s) => s && !s.startsWith('@') && !s.startsWith('from') && !s.startsWith('to'));
const missingPrefix = allRuleSelectors
  .filter((s) => !s.split(',').every((p) => p.trim().startsWith(PREFIX)));
ok(missingPrefix.length === 0,
  `每条规则都带 ${PREFIX} 前缀${missingPrefix.length ? '（漏：' + missingPrefix.join(' | ') + '）' : ''}`);

const sels = selectorsOf(THEME);
ok(sels.size >= 20, `starfall 有实质内容（${sels.size} 条选择器）`);
// 前缀本身就是 .s3d，余下部分必然是它的后代选择器，无需再判"是否在子树内"；
// 真正要防的是余下部分点到 SPA 模块（那会让舞台主题染到应用布局上）。
const spa = [...sels].filter((s) => /\.(app|rail|column|view|track|q-row|pl-row|bar)\b/.test(s));
ok(spa.length === 0, `starfall 不触碰 SPA 模块${spa.length ? '（' + spa.join(' ') + '）' : ''}`);
ok(!/data-skin/.test(body), 'starfall 不引用皮肤选择器（两个维度互不感知）');

// ---------------------------------------------------------------------------
// 3. 与皮肤正交：星落不在 Skins 目录里
// ---------------------------------------------------------------------------

section('正交：星落是舞台主题，不是皮肤');

ok(!/id:\s*'starfall'/.test(SKINS_JS), 'Skins 目录里没有 starfall（不与皮肤互斥）');
ok(!/data-skin-css="starfall"/.test(HTML), 'index.html 没有把星落挂成皮肤 link');
ok(/stageTheme/.test(STAGE3D_JS), 'stage3d 持有 stageTheme 偏好');
ok(/root\.dataset\.stageTheme/.test(STAGE3D_JS), 'stage3d 把主题写进 #stage3d 的 data-stage-theme');
ok(/stageTheme:\s*stageTheme/.test(STAGE3D_JS), 'stageTheme 随舞台偏好持久化');
// 只剩一档时下拉本身就是个假选择（点开只有「星落」），界面上不再摆它；
// 但主题层还要靠 #stage3d 上的 data-stage-theme 命中 starfall.css，不能连属性一起删。
ok(!/id="s3d-stage-theme"/.test(HTML), '舞台设置里不再摆只有一个选项的「舞台风格」下拉');
ok(!/s3d-stage-theme/.test(STAGE3D_JS), 'stage3d 不再同步/绑定这个下拉');
ok(!/select\('舞台主题'/.test(WORKSHOP), '创意工坊里也不再摆选了不生效的「舞台主题」');
ok(/Stage3D\.defaults\(\)/.test(WORKSHOP) && /Stage3D\.resetSettings\(\)/.test(WORKSHOP), '工坊模板与完整恢复共用舞台默认值，避免遗漏 stageTheme');

// ---------------------------------------------------------------------------
// 4. 静默丢弃：混用引擎私有伪元素
// ---------------------------------------------------------------------------

section('静默丢弃：不许把 ::-webkit- 与 ::-moz- 混在同一条规则里');

const mixed = [];
for (const m of body.matchAll(/([^{}]+)\{/g)) {
  const sel = m[1].trim();
  if (!sel || sel.startsWith('@')) continue;
  for (const part of sel.split(',')) {
    if (/::-webkit-/.test(part) && /::-moz-/.test(part)) mixed.push(part.trim());
  }
}
ok(mixed.length === 0,
  `没有混用引擎私有伪元素${mixed.length ? '（' + mixed.join(' | ') + '）' : ''}`);

// ---------------------------------------------------------------------------
// 5. 沉浸行为：静止时歌单架与播放舱都收走
// ---------------------------------------------------------------------------

section('沉浸：鼠标静止后歌单架与播放舱一起收走');

ok(/\.s3d\.s3d-shelf-on:not\(\.s3d-chrome\) \.s3d-shelf \{\s*opacity:\s*0/.test(STAGE3D_CSS),
  '静止时 3D 歌单架淡出（含侧栏模式）');
const playerBase = body.match(/\.s3d\[data-stage-theme="starfall"\] \.s3d-player \{([^}]*)\}/);
const playerAwake = body.match(/\.s3d\[data-stage-theme="starfall"\]\.s3d-chrome \.s3d-player \{([^}]*)\}/);
ok(playerBase && /opacity:\s*0/.test(playerBase[1]), '星落的播放舱静止时整条收走');
ok(playerAwake && /opacity:\s*1/.test(playerAwake[1]), '唤醒 chrome 时播放舱浮现');
ok(playerBase && /grid-template-columns:\s*0fr/.test(playerBase[1])
  && playerAwake && /grid-template-columns:\s*auto/.test(playerAwake[1]),
  '播放舱从进度发丝弹开成完整播放条（两态尺寸不同）');

// ---------------------------------------------------------------------------
// 6. 接线
// ---------------------------------------------------------------------------

section('接线：HTML / 路由 / 顺序');

ok(/<link rel="stylesheet" href="stage-themes\/starfall\.css">/.test(HTML),
  'starfall.css 常驻引入（主题不像皮肤那样按需启用）');
ok(HTML.indexOf('href="stage3d.css"') < HTML.indexOf('href="stage-themes/starfall.css"'),
  'starfall.css 排在 stage3d.css 之后（同特异性下覆盖基础样式）');
// 只匹配文件名后缀，不写死相对深度：前端目录搬过位置（web/ → plugin/ui/）。
ok(/edition_ui!\("stage-themes\/starfall\.css"\)/.test(MAIN_RS), 'starfall.css 编进二进制');
ok(/"\/stage-themes\/starfall\.css"/.test(MAIN_RS), 'main.rs 注册了 /stage-themes/starfall.css 路由');

section('星落是唯一一档：入口已收起，classic 与 iOS 都已下架');

// 两档都不是「不好看」，是留不住：
//  · classic 就是没有主题层的裸样式。吸顶标题栏的近不透明底色靠它自己盖住滚过的行，
//    玻璃层各自把标题改成 12% 透明后，裸层那份反而没人管了 —— 标题被透上来的行叠成乱码。
//  · iOS 是同一批纪律下的第二份观感，两份玻璃要同步改、同步测，而界面上只有一档在用。
// 下架后连下拉一起收掉：只剩一档时它只是个选不动的装饰。旧偏好不另做映射，
// 存过 classic / iOS 的值走白名单校验自然落回星落。
// 注意别在整份 HTML 上搜 'classic'：「歌词视觉」里也叫 classic（流光歌词），会误伤。
ok(!/<select id="s3d-stage-theme"/.test(HTML), 'index.html 里已没有「舞台风格」下拉');
ok(!/舞台风格/.test(HTML), '设置面板里已没有「舞台风格」标签');
ok(/root\.dataset\.stageTheme\s*=\s*stageTheme/.test(STAGE3D_JS),
  '主题仍固定写进 #stage3d 的 data-stage-theme（starfall.css 靠它命中）');
ok(!/stageTheme\s*=\s*sel\.value/.test(STAGE3D_JS), '主题不再由下拉改写');
ok(!fs.existsSync(path.join(WEB, 'stage-themes', 'ios.css')), 'stage-themes/ios.css 已删除');
ok(!/stage-themes\/ios\.css/.test(HTML + MAIN_RS), 'ios.css 的 link 与路由一并撤掉（不留半截接线）');
ok(/var stageTheme = 'starfall'/.test(STAGE3D_JS), '默认档是星落');
ok(!/value\.stageTheme === 'classic'|value\.stageTheme === 'ios'/.test(STAGE3D_JS),
  '恢复白名单不认 classic / iOS：存过它们的偏好直接落回默认档，不做旧值映射');

const sharedDrawer = read(path.join(WEB, 'space3d.css'));
ok(/\.sp-sheet h2\s*\{[^}]*position:\s*sticky[^}]*background:\s*var\(--sp-glass-strong\)[^}]*backdrop-filter:/.test(sharedDrawer),
  '共享设置抽屉使用吸顶标题栏与统一玻璃材质');
ok(/class="sp-sheet" id="s3d-settings"/.test(HTML), '声场复用三维空间的设置抽屉');
ok(!/\.s3d-settings\b/.test(THEME), '舞台主题不覆盖共享设置抽屉');

// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(60));
if (failures) {
  console.error(`舞台主题契约检查：${checks} 项，${failures} 项失败`);
  process.exit(1);
}
console.log(`舞台主题契约检查：${checks}/${checks} 全部通过`);
