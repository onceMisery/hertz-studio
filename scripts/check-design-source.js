#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 设计单源契约（设计收敛 §6.1/§12.2）：
//
//   node scripts/check-design-source.js
//
// definition.json 是唯一手工维护的设计源；design-base.css / design-themes.js
// 是生成物。这里钉五件事：
//   1. 生成物与源一致（重新生成并逐字节比对，手改生成物即红）。
//   2. index.html 装载顺序：设计 CSS 先于 style.css，目录数据先于 themes.js。
//   3. style.css 不残留生成令牌的 :root 默认值副本（@media 内的响应式覆盖
//      与行为性覆盖放行——它们不是默认值）。
//   4. themes.js 真的消费生成目录：沙箱求值后 Theme.list() 与 definition.json
//      逐套逐键一致（目录缺失时的 console.error 兜底不允许变成第二份数据）。
//   5. 生成器静态派生的 --accent-rgb / --accent-2-rgb 与 themes.js apply() 的
//      运行时派生在默认主题上逐值一致（两处实现的等价性用真实求值比对钉住）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { generate } = require('./generate-design');

const root = path.join(__dirname, '..');
const ui = path.join(root, 'plugin', 'ui');
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { console.error('FAIL ' + label); process.exitCode = 1; }
  else console.log('PASS ' + label);
}

const def = JSON.parse(fs.readFileSync(path.join(ui, 'design', 'definition.json'), 'utf8'));

// 1. 生成物漂移
const { css: genCss, dataJs: genData } = generate();
ok(fs.readFileSync(path.join(ui, 'design', 'design-base.css'), 'utf8') === genCss,
  'design-base.css 与 definition.json 一致（无手改漂移）');
ok(fs.readFileSync(path.join(ui, 'design', 'design-themes.js'), 'utf8') === genData,
  'design-themes.js 与 definition.json 一致（无手改漂移）');

// 2. 装载顺序
const indexHtml = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
ok(indexHtml.indexOf('design/design-base.css') >= 0 && indexHtml.indexOf('design/design-base.css') < indexHtml.indexOf('href="style.css"'),
  'design-base.css 排在 style.css 之前（首帧配色由生成物保证）');
ok(indexHtml.indexOf('design/design-themes.js') >= 0 && indexHtml.indexOf('design/design-themes.js') < indexHtml.indexOf('src="themes.js"'),
  'design-themes.js 排在 themes.js 之前（目录数据先于机制）');

// 3. style.css 残留副本（剥掉 @media 块后扫 :root 声明）
const genTokenNames = new Set();
for (const group of Object.values(def.scales || {})) {
  for (const key of Object.keys(group.tokens || {})) genTokenNames.add(key);
}
for (const theme of def.themes) for (const key of Object.keys(theme.tokens)) genTokenNames.add(key);
for (const key of (def.$meta.derivedStaticRgb || {}).keys || []) genTokenNames.add(key);
function stripMediaBlocks(text) {
  let out = text;
  for (;;) {
    const at = out.search(/@media[^{]*\{/);
    if (at < 0) return out;
    let depth = 0;
    let i = out.indexOf('{', at);
    for (; i < out.length; i += 1) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    // 连 @media 头一起替换掉，避免下一轮 search 又找到同一个块。
    out = out.slice(0, at) + out.slice(i + 1);
  }
}
const styleNoMedia = stripMediaBlocks(fs.readFileSync(path.join(ui, 'style.css'), 'utf8'));
// 只扫 :root 块：body[data-density] 等状态选择器的覆盖是行为响应，不是默认值。
const leftovers = [];
for (const match of styleNoMedia.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const decl of match[1].matchAll(/(--[\w-]+)\s*:/g)) {
    if (genTokenNames.has(decl[1])) leftovers.push(decl[1]);
  }
}
ok(leftovers.length === 0,
  'style.css 的 :root 不再定义生成令牌（残留: ' + leftovers.join(', ') + '）');

// 4 + 5. 沙箱求值：themes.js 消费生成目录，运行时派生与静态派生一致
const dataJs = fs.readFileSync(path.join(ui, 'design', 'design-themes.js'), 'utf8');
const themesJs = fs.readFileSync(path.join(ui, 'themes.js'), 'utf8');
const captured = new Map();
const sandbox = {
  window: { console },
  console,
  document: {
    documentElement: {
      style: {
        setProperty(key, value) { captured.set(key, value); },
        removeProperty(key) { captured.delete(key); },
      },
      setAttribute() {},
    },
  },
};
sandbox.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(dataJs, sandbox, { filename: 'design/design-themes.js' });
vm.runInContext(themesJs, sandbox, { filename: 'themes.js' });
const Theme = vm.runInContext('window.Theme', sandbox);
ok(!!Theme && typeof Theme.apply === 'function', 'themes.js 在生成目录上求值出 Theme');
Theme.apply(def.$meta.defaultTheme, { silent: true });

const listed = Theme.list();
ok(listed.length === def.themes.length,
  `目录条数一致（Theme.list ${listed.length} / definition ${def.themes.length}）`);
ok(listed[0].id === def.$meta.defaultTheme && listed.map((t) => t.id).join() === def.themes.map((t) => t.id).join(),
  '目录 id 与顺序逐条一致（默认主题打头是 themes.js register() 的基底契约）');
let tokenDrift = '';
for (let i = 0; i < def.themes.length; i += 1) {
  for (const [key, value] of Object.entries(def.themes[i].tokens)) {
    if (listed[i].tokens[key] !== value) tokenDrift += `${def.themes[i].id}${key} `;
  }
}
ok(tokenDrift === '', '每套主题每个令牌值逐键一致（偏差: ' + tokenDrift + '）');

for (const key of (def.$meta.derivedStaticRgb || {}).keys || []) {
  const source = key === '--accent-rgb' ? '--accent' : '--accent-2';
  ok(captured.get(key) !== undefined && captured.get(key) === genCss.match(new RegExp(`${key}: ([^;]+);`))[1],
    `${key} 运行时派生与生成器静态派生一致（来源 ${source}）`);
}
for (const [key, value] of Object.entries(def.themes[0].tokens)) {
  ok(captured.get(key) === value, `默认主题 ${key} 经 apply() 写入的值与 definition 一致`);
}

console.log(`\n设计单源契约：${checks} 项${process.exitCode ? '，存在失败' : '全部通过'}`);
