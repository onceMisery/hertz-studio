#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CSS 令牌契约检查（零依赖，静态扫描，不需要浏览器）。
//
// 为什么需要它：style.css 与 stage.css 都在 :root 上声明变量，stage.css 在
// <link> 里排在 style.css 之后，**同优先级整块覆盖**。一旦两个文件对同名令牌
// 的约定不一致（style.css 的 --glass-border 是 `1px solid <color>` 完整简写、
// --glass-shadow 是三层阴影列表；曾经 stage.css 写成裸色值），覆盖后
// style.css 里的 `border: var(--glass-border)` / `box-shadow: var(--glass-shadow)`
// 会变成非法值被浏览器整条丢弃，而 stage.css 自己的组件因为拼出了
// `1px solid <color>` / `0 8px 28px <color>` 反而侥幸正常 —— 页面不会报错、
// 不崩、也不缺元素，只是「舞台和播放条有描边投影、顶栏/导航轨/曲库面板没有」。
// 这种静默降级只能靠断言兜住。
//
// 用法: node scripts/check-css-tokens.js [web 目录]

'use strict';

const fs = require('fs');
const path = require('path');

const webDir = process.argv[2] || path.join(__dirname, '..', 'crates', 'vmusicd', 'web');

// 共享令牌：全站只有一个定义处，即 style.css 的 :root。
// stage.css 只允许声明自己独占的 --stage-*。
const SHARED_TOKENS = [
  '--glass-bg',
  '--glass-border',
  '--glass-shadow',
  '--glass-shadow-glow',
  '--glass-blur',
  '--hover',
];
const OWNER_FILE = 'style.css';

// 实心按钮的 hover 契约：.ctrl:hover / .btn:hover 这类基础态 hover 的特异性
// 可能高于实心态自身，若 hover 规则只写 box-shadow 而不重新声明 background，
// 实心底就会被 --hover 的浅色底盖掉（图标与底色同色 => 直接隐身）。
const SOLID_HOVER_CONTRACT = [
  {
    file: 'style.css',
    selector: '.ctrl-primary:hover',
    must: ['background', 'color'],
    why: '主播放键是实心白圆盘；.ctrl:hover 特异性 (0,2,0) 高于 .ctrl-primary 的 (0,1,0)',
  },
];

const LENGTH_RE = /\d*\.?\d+(px|rem|em|%|vh|vw)\b/;
const BORDER_STYLE_RE = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;

function stripComments(src) {
  // 用等量空白替换注释，保留换行，使索引与原文对齐、行号可直接换算
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

// 扫出所有非嵌套规则块。@media 这类只起包裹作用的外层块因为 `{` 紧跟 `{`
// 不会被匹配成规则，其内部规则仍然会被逐个扫到。
function scanRules(clean) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    // m.index 落在选择器之前的空白上（上一块结尾到本块之间都算 `[^{}]+`），
    // 要跳过前导空白才是指向选择器本身的偏移
    const lead = m[1].search(/\S/);
    rules.push({
      selector: m[1].trim(),
      body: m[2],
      selectorIndex: m.index + (lead < 0 ? 0 : lead),
      bodyIndex: m.index + m[1].length + 1,
    });
  }
  return rules;
}

// 返回带绝对偏移的声明列表，偏移用于把问题定位到具体那一行（而不是块首）
function declarations(body, base) {
  const out = [];
  let pos = 0;
  for (const chunk of body.split(';')) {
    const lead = chunk.search(/\S/);
    if (lead >= 0) {
      const text = chunk.trim();
      const i = text.indexOf(':');
      out.push({
        prop: (i < 0 ? text : text.slice(0, i).trim()).toLowerCase(),
        value: i < 0 ? '' : text.slice(i + 1).trim(),
        index: base + pos + lead,
      });
    }
    pos += chunk.length + 1; // +1 补回分隔用的分号
  }
  return out;
}

const problems = [];
const checked = { fields: 0, rules: 0 };

const files = fs
  .readdirSync(webDir)
  .filter((f) => f.endsWith('.css') && !f.endsWith('.bak'));

for (const file of files) {
  const raw = fs.readFileSync(path.join(webDir, file), 'utf8');
  const clean = stripComments(raw);
  const rules = scanRules(clean);
  checked.rules += rules.length;

  for (const rule of rules) {
    const ruleLine = lineOf(clean, rule.selectorIndex);
    const decls = declarations(rule.body, rule.bodyIndex);

    for (const d of decls) {
      const line = lineOf(clean, d.index);

      // --- 契约 A：共享令牌只能由 style.css 的 :root 定义 ---
      if (SHARED_TOKENS.includes(d.prop)) {
        checked.fields++;
        if (file !== OWNER_FILE || rule.selector !== ':root') {
          problems.push({
            file,
            line,
            rule: `共享令牌 ${d.prop} 定义在 ${file} 的 \`${rule.selector}\`（块首 ${ruleLine} 行）`,
            why: `它由 ${OWNER_FILE} 的 :root 独占定义；本文件后加载会整块覆盖，导致 ${OWNER_FILE} 里的用法静默失效`,
          });
        }
      }

      // --- 契约 B：阴影令牌已是完整列表，不能再拼接长度 ---
      if (d.prop === 'box-shadow' && /var\(\s*--glass-shadow(-\w+)?\s*\)/.test(d.value)) {
        checked.fields++;
        const residue = d.value.replace(/var\([^)]*\)/g, ' ');
        if (LENGTH_RE.test(residue)) {
          problems.push({
            file,
            line,
            rule: `box-shadow 里把长度和 var(--glass-shadow*) 拼在一起: ${d.value.replace(/\s+/g, ' ')}`,
            why: '该令牌本身已是完整阴影列表（可能多段），拼接会产出非法值、整条声明被丢弃',
          });
        }
      }

      // --- 契约 C：描边令牌已是完整简写，不能再补 1px solid ---
      if (d.prop.startsWith('border') && d.value.includes('var(--glass-border)')) {
        checked.fields++;
        const residue = d.value.replace(/var\([^)]*\)/g, ' ');
        if (LENGTH_RE.test(residue) || BORDER_STYLE_RE.test(residue)) {
          problems.push({
            file,
            line,
            rule: `border 简写与 var(--glass-border) 重复: ${d.value.replace(/\s+/g, ' ')}`,
            why: '该令牌本身已是 "1px solid <color>"，重复书写会变成非法值（border 风格被重置为 none）',
          });
        }
      }

      // --- 契约 D：实心按钮的 hover 必须重新声明底色 ---
      const contract = SOLID_HOVER_CONTRACT.find(
        (c) => c.file === file && c.selector === rule.selector
      );
      if (contract) {
        checked.fields++;
        const props = decls.map((x) => x.prop);
        const missing = contract.must.filter((p) => !props.includes(p));
        if (missing.length) {
          problems.push({
            file,
            line,
            rule: `${contract.selector} 缺少 ${missing.join(' / ')}`,
            why: contract.why,
          });
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`CSS 令牌契约检查未通过（扫描 ${checked.rules} 条规则 / ${checked.fields} 个受检声明）\n`);
  for (const p of problems) {
    console.error(`  ✗ ${p.file}:${p.line}`);
    console.error(`      ${p.rule}`);
    console.error(`      为什么不行：${p.why}`);
  }
  console.error(`\n共 ${problems.length} 处问题。`);
  process.exit(1);
}

console.log(
  `CSS 令牌契约检查通过（${files.length} 个文件 / ${checked.rules} 条规则 / ${checked.fields} 个受检声明）`
);
