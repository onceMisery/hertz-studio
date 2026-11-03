#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 设计定义生成器：从 design/definition.json 生成两份产物（设计收敛 §6.1）。
//
//   node scripts/generate-design.js            写出产物
//   node scripts/generate-design.js --check    重新生成并与磁盘比对，漂移即失败
//
// 产物（纳入版本控制，禁止手改）：
//   plugin/ui/design/design-base.css   静态尺度令牌 + 默认主题颜色 + 派生 rgb
//                                      + 环境回退。style.css 的 :root 令牌层
//                                      由此替代；页面加载到 Theme.init() 之间的
//                                      首帧配色由它保证（不再靠人工对齐注释）。
//   plugin/ui/design/design-themes.js  内置主题目录静态数据，themes.js 消费；
//                                      主题机制（登记/应用/恢复/派生）仍在
//                                      themes.js，这里只有数据。
//
// 生成器只描述自己输出的设计资源；实际发布资源仍从 assets.rs 清单与
// index.html 接入（不建第二张资源清单，见设计 §9.2）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UI_DIR = path.join(__dirname, '..', 'plugin', 'ui');
const DEFINITION_PATH = path.join(UI_DIR, 'design', 'definition.json');
const CSS_PATH = path.join(UI_DIR, 'design', 'design-base.css');
const DATA_PATH = path.join(UI_DIR, 'design', 'design-themes.js');

const GENERATED_BANNER = (kind) => `生成物：由 scripts/generate-design.js 从 design/definition.json 生成——禁止手改。
修改设计请编辑 definition.json 后运行 node scripts/generate-design.js；
check-design-source（CI）会重新生成并比对，手改会被拒绝。${kind}`;

function loadDefinition() {
  const def = JSON.parse(fs.readFileSync(DEFINITION_PATH, 'utf8'));
  const themes = def.themes || [];
  const defaultTheme = def.$meta && def.$meta.defaultTheme;
  if (!defaultTheme) throw new Error('definition.json 缺少 $meta.defaultTheme');
  const ids = new Set();
  for (const theme of themes) {
    if (!theme || typeof theme.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(theme.id)) {
      throw new Error(`主题 id 非法: ${theme && theme.id}`);
    }
    if (ids.has(theme.id)) throw new Error(`主题 id 重复: ${theme.id}`);
    ids.add(theme.id);
    if (!theme.tokens || typeof theme.tokens !== 'object') throw new Error(`主题 ${theme.id} 缺 tokens`);
    for (const key of Object.keys(theme.tokens)) {
      if (!key.startsWith('--')) throw new Error(`主题 ${theme.id} 的令牌键须以 -- 开头: ${key}`);
    }
  }
  if (!ids.has(defaultTheme)) throw new Error(`默认主题 ${defaultTheme} 不在目录里`);
  // themes.js 的 register() 把新主题的 tokens 合并到 CATALOG[0]（默认主题）上作基底，
  // 所以生成目录必须默认主题打头——这里是机制契约，不是排版偏好。
  if (themes[0].id !== defaultTheme) {
    throw new Error(`默认主题 ${defaultTheme} 必须是目录第一项（themes.js register() 的基底），实得 ${themes[0].id}`);
  }
  // 结构尺度是 themes.js 的「颜色是唯一的自由量」红线：主题令牌不得撞名
  // （撞名时优先级由源顺序决定，等于埋一条静默覆盖）。材质/表面/语义组
  // （glass/fields/surfaces/track/focus/semantic/legacy）是主题的合法覆盖面。
  const STRUCTURAL_GROUPS = ['font', 'type', 'space', 'radius', 'motion', 'structure', 'art'];
  const structural = new Set();
  const scaleNames = new Set();
  for (const [group, content] of Object.entries(def.scales || {})) {
    for (const key of Object.keys(content.tokens || {})) {
      if (scaleNames.has(key)) throw new Error(`尺度令牌跨组重复: ${key}`);
      scaleNames.add(key);
      if (STRUCTURAL_GROUPS.includes(group)) structural.add(key);
    }
  }
  for (const theme of themes) {
    for (const key of Object.keys(theme.tokens)) {
      if (structural.has(key)) {
        throw new Error(`主题 ${theme.id} 的 ${key} 撞了结构尺度（颜色是唯一的自由量，尺度不进主题表）`);
      }
    }
  }
  return def;
}

// 与 themes.js apply() 运行时派生同一规则（六位 hex → "r, g, b"）。
// 两处实现的一致性由 check-design-source 用真实 Theme.apply 比对兜住。
function hexToRgbTriplet(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ');
}

function cssComment(text, indent) {
  const pad = ' '.repeat(indent);
  const lines = String(text).split('\n').map((l) => pad + l);
  return pad + '/*\n' + lines.join('\n') + '\n' + pad + '*/';
}

function renderCss(def) {
  const banner = GENERATED_BANNER(
    '\n本文件是 :root 设计令牌（静态尺度 + 默认主题颜色 + 派生 rgb + 环境回退）的唯一来源。')
    .split('\n').map((l) => (l ? '   ' + l : ''));
  const out = [];
  out.push('/* SPDX-License-Identifier: MIT');
  out.push('   Copyright (c) 2026 hertz-studio contributors');
  out.push('');
  out.push(...banner);
  out.push('   */');
  out.push('');
  out.push(':root {');
  for (const [group, content] of Object.entries(def.scales || {})) {
    if (content.doc) out.push(cssComment(content.doc, 2));
    for (const [key, value] of Object.entries(content.tokens || {})) {
      out.push(`  ${key}: ${value};`);
    }
    out.push('');
  }
  const defaultTheme = def.themes[0];
  out.push('  /* 默认主题（页面加载到 Theme.init() 之间由这里保证首帧配色；');
  out.push('     themes.js apply() 之后由行内变量接管）。 */');
  for (const [key, value] of Object.entries(defaultTheme.tokens)) {
    out.push(`  ${key}: ${value};`);
  }
  const derived = (def.$meta && def.$meta.derivedStaticRgb) || { keys: [] };
  if (derived.doc) out.push(cssComment(derived.doc + '\n' + (derived.rule || ''), 2));
  for (const key of derived.keys || []) {
    const source = key === '--accent-rgb' ? '--accent' : key === '--accent-2-rgb' ? '--accent-2' : null;
    if (!source) throw new Error(`派生键 ${key} 缺少来源映射`);
    const triplet = hexToRgbTriplet(defaultTheme.tokens[source]);
    if (!triplet) throw new Error(`默认主题 ${source} 不是六位 hex，派生不出 ${key}`);
    out.push(`  ${key}: ${triplet};`);
  }
  out.push('}');
  const fallbacks = def.fallbacks;
  if (fallbacks) {
    out.push('');
    if (fallbacks.doc) out.push('/* ' + fallbacks.doc.replace(/\n/g, '\n   ') + ' */');
    out.push(`${fallbacks.condition} {`);
    out.push('  :root {');
    for (const [key, value] of Object.entries(fallbacks.declarations || {})) {
      out.push(`    ${key}: ${value};`);
    }
    out.push('  }');
    out.push('}');
  }
  out.push('');
  return out.join('\n');
}

function renderData(def) {
  const bannerLines = GENERATED_BANNER(' themes.js 只保留主题机制（登记/应用/恢复/派生），这里只有静态数据。')
    .split('\n').map((l) => '// ' + l);
  const header = [
    '// SPDX-License-Identifier: MIT',
    '// Copyright (c) 2026 hertz-studio contributors',
    '//',
    ...bannerLines,
    '',
    'window.__HERTZ_DESIGN_THEMES = ',
  ].join('\n');
  return header + JSON.stringify(def.themes, null, 2) + ';\n';
}

function generate() {
  const def = loadDefinition();
  return { css: renderCss(def), dataJs: renderData(def) };
}

function main() {
  const check = process.argv.includes('--check');
  const { css, dataJs } = generate();
  let failed = false;
  for (const [file, content] of [[CSS_PATH, css], [DATA_PATH, dataJs]]) {
    const disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (disk === content) continue;
    failed = true;
    if (check) {
      const diskLines = (disk || '').split('\n');
      const genLines = content.split('\n');
      let at = 0;
      while (at < diskLines.length && at < genLines.length && diskLines[at] === genLines[at]) at += 1;
      console.error(`漂移: ${path.relative(process.cwd(), file)} 首个差异在第 ${at + 1} 行`);
      console.error(`  磁盘: ${diskLines[at]}`);
      console.error(`  生成: ${genLines[at]}`);
      console.error('重跑 node scripts/generate-design.js 同步产物；不要手改生成物。');
    } else {
      fs.writeFileSync(file, content);
      console.log(`已写出 ${path.relative(process.cwd(), file)}`);
    }
  }
  if (check) {
    if (failed) process.exit(1);
    console.log('生成物与 definition.json 一致');
  }
}

module.exports = { generate, loadDefinition, hexToRgbTriplet };

if (require.main === module) main();
