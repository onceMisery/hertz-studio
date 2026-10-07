#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 出处名禁用词扫描（负面不变量）。
//
//   node scripts/check-lineage-names.js
//
// 2026-10 的改名把上游参考项目的名字从产品里撤掉了：歌词视觉层 `folia` →
// `stanza`、皮肤 id `mineradio` → `sheen`、13 个主题 id 去掉 `vcp-` 前缀、
// 产物与 crate 改叫 hertz-studio。上游署名集中在 `NOTICE`。
//
// 这类「删掉的东西」最容易跟着别的功能修复漂回来：注释里顺手写一句上游名不会
// 报错，皮肤说明文案里带上商标名也看不见（本次扫描就是抓到 `skins.js` 的
// `note` 字段把上游名写进了界面 tooltip）。所以钉成断言，分两档：
//
//   1. 整文件（注释也算）：`Mineradio` / `VCPChat` / `vcp-` 不许出现在
//      plugin/ 与 crates/。这两个是纯上游身份，出处只写在 NOTICE。
//   2. 注释以外的一切（标识符、字符串字面量、HTML 可见文字与属性）：`folia`
//      不许出现。现存注释里的历史出处说明暂时放行，但不许长进代码与文案里。
//
// 断言对象是原文本身。参考实现里「正则匹配魔法数字 / 禁用标识名」那半边不学
// （见 docs/research/mineradio-full-assessment.md §4 D2），要的是「必须保持删掉」
// 这一半边。
//
// 零依赖，不触网。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['plugin', 'crates'];
const EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.rs', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'target', 'output', 'vendor', 'dist', '.git']);
// 构建产物按 target-*/ 与 output/ 的目录名约定隔离。
const SKIP_PREFIX = ['target-'];

const OUTSIDE_COMMENTS = 1;
const EVERYWHERE = 2;

const RULES = [
  { re: /mineradio/ig, tier: EVERYWHERE, why: '上游项目名；皮肤 id 已改名 sheen，署名只写 NOTICE' },
  { re: /vcpchat/ig, tier: EVERYWHERE, why: '上游项目名' },
  { re: /\bvcp-[a-z]/ig, tier: EVERYWHERE, why: '主题 id 已去掉 vcp- 前缀' },
  { re: /\bfolia\b/ig, tier: OUTSIDE_COMMENTS, why: '歌词视觉层已改名 stanza；上游名不该进标识符或界面文案' },
];

/// 把原文按位置分类：0 = 生效代码/文案，1 = 注释。按字符走，所以同行后半段
/// 不会被整行连带抹掉；字符串按引号成对消费，`https://…` 不会被当成行注释起点。
function commentMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  const mark = (from, to) => { for (let k = from; k < to && k < mask.length; k += 1) mask[k] = 1; };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      mark(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && n === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      mark(i, j);
      i = j;
      continue;
    }
    if (c === '<' && n === '!' && text.startsWith('!--', i + 1)) {
      const end = text.indexOf('-->', i + 3);
      const stop = end < 0 ? text.length : end + 3;
      mark(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { j += 1; break; }
        if (text[j] === '\n' && q !== '`') break; // 坏数据：不吞整文件
        j += 1;
      }
      i = j; // 字符串永远算生效
      continue;
    }
    i += 1;
  }
  return mask;
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_PREFIX.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

let failures = 0;
let files = 0;
let bytes = 0;
let commentKept = 0;

function locationOf(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1);
  return { line, col };
}

function report(rel, text, index, match, why, inComment) {
  failures += 1;
  const { line, col } = locationOf(text, index);
  const excerpt = text.slice(Math.max(0, index - 44), index + 44).replace(/\s+/g, ' ').trim();
  console.error(`  ✗ ${rel}:${line}:${col} 「${match}」出现在${inComment ? '注释' : '生效代码/文案'} — ${why}`);
  console.error(`      ${excerpt}`);
}

const targets = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full, targets);
}

for (const abs of targets) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const text = fs.readFileSync(abs, 'utf8');
  files += 1;
  bytes += text.length;
  const mask = commentMask(text);

  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const index = m.index;
      const inComment = mask[index] === 1;
      if (inComment) commentKept += 1;
      if (rule.tier === EVERYWHERE || !inComment) {
        report(rel, text, index, m[0], rule.why, inComment);
      }
    }
  }
}

if (!failures) {
  console.log(`出处名禁用词扫描通过：${files} 个文件 / ${(bytes / 1024).toFixed(0)} KB，` +
    `${RULES.length} 条规则零命中（上游署名见 NOTICE）`);
} else {
  console.log(`\n出处名禁用词扫描：${failures} 处命中` +
    (commentKept ? `（另有 ${commentKept} 处只在注释里，按第 2 档放行）` : ''));
}
process.exit(failures ? 1 : 0);
