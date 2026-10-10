#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 决策日志（ADR）的一致性检查（零依赖、不触网）。
//
//   node scripts/check-adrs.js
//
// 起因是借鉴清单 §4 D6：文档要写成**决策日志**（数值边界 + 该改哪个函数 + 禁止回退
// 清单），而不是「我们为什么选 X」。那种写法才有约束力 —— 而只有被脚本引用的约束
// 才真的不会被改掉。
//
// 这里钉三件事：
//
//   1. 每篇 ADR 都有那三段。缺一段就等于它只是一篇随笔。
//   2. 「边界与 owner」表里每一行的数值，必须与源码里那个常量的字面量**现在**仍然
//      相等。数字被改而文档没跟上（或反过来）都算红 —— 这条检查的全部意义就在这儿。
//   3. `README.md` 的索引必须列出每一篇，不许有游离的 ADR。
//
// 支持的字面量形状：`NAME: usize = 500`、`NAME = 20_000`、`NAME = 6 * 1024 * 1024`、
// `Duration::from_secs(20)`、`Duration::from_millis(4000)`。单位写在行的名称里
// （如「（毫秒）」），数值列只放纯数字，避免同一个数字有两种写法。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}
function section(name) { console.log('\n' + name); }

const REQUIRED_SECTIONS = ['## 决定', '## 边界与 owner', '## 禁止回退'];

/// 从一行里取表格单元格（`| a | b |` 形状）。
function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  const parts = t.slice(1, -1).split('|').map((c) => c.trim());
  return parts;
}

/// 把源码里的数字字面量算成一个数：支持 `_`、`*` 乘积、from_secs/from_millis。
/// 返回 null 表示这一行里没有可算的数。
function evalLiteral(text) {
  const dur = /Duration::from_(secs|millis)\(\s*([0-9_]+(?:\s*\*\s*[0-9_]+)*)\s*\)/.exec(text);
  if (dur) {
    const n = evalProduct(dur[2]);
    return n === null ? null : { value: n, unit: dur[1] === 'secs' ? 's' : 'ms' };
  }
  const m = /=\s*([0-9][0-9_]*(?:\s*\*\s*[0-9][0-9_]*)*)/.exec(text);
  if (!m) return null;
  const n = evalProduct(m[1]);
  return n === null ? null : { value: n, unit: null };
}

function evalProduct(text) {
  // Rust 的 `20_000` 是同一个数，先去掉分隔下划线；`6 * 1024 * 1024` 按乘积算。
  const cleaned = text.replace(/_/g, '').trim();
  if (!/^(\d+)(\s*\*\s*(\d+))*$/.test(cleaned)) return null;
  const nums = cleaned.split('*').map((s) => parseInt(s.trim(), 10));
  return nums.reduce((a, b) => a * b, 1);
}

/// 在指定文件里找常量的定义，返回「从常量名开始的那段」。名字两边不许是标识符字符
/// （否则 MAX 会撞上 X_MAX），一行里连写两个常量（`var A = 1, B = 2`）也各自命中。
function findDefinition(src, name) {
  const lines = src.split(/\r?\n/);
  const hits = [];
  for (const line of lines) {
    let at = line.indexOf(name);
    while (at >= 0) {
      const before = at === 0 ? '' : line[at - 1];
      const after = line[at + name.length] || '';
      const edgeOk = !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
      if (edgeOk && /=/.test(line.slice(at))) hits.push(line.slice(at));
      at = line.indexOf(name, at + name.length);
    }
  }
  return hits;
}

(function main() {
  if (!fs.existsSync(ADR_DIR)) {
    console.error('  ✗ 缺少 docs/aegis/adr/ 目录');
    process.exit(1);
  }
  const files = fs.readdirSync(ADR_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  section('ADR 清单与结构');
  ok(files.length >= 5, `adr/ 下至少有 5 篇决策日志（实得 ${files.length}）`);

  const readme = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');
  for (const f of files) {
    ok(readme.includes(f), `README.md 的索引列出了 ${f}`);
  }

  const cache = new Map();
  const readSrc = (rel) => {
    if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return cache.get(rel);
  };

  section('每一行的数值都与源码一致');
  let rows = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ADR_DIR, f), 'utf8');
    for (const s of REQUIRED_SECTIONS) ok(text.includes(s), `${f} 有「${s}」一节`);
    const body = text.split('## 边界与 owner')[1] || '';
    const table = body.split('## ')[0];
    for (const line of table.split(/\r?\n/)) {
      const c = cells(line);
      if (!c || c.length < 4) continue;
      if (/^:?-{2,}/.test(c[0])) continue;         // 分隔行
      if (c[2].includes('定义在哪')) continue;      // 表头
      const [, valueRaw, ownerRaw] = c;
      const m = /^`([^`]+)::([A-Za-z0-9_]+)`$/.exec(ownerRaw);
      if (!m) {
        ok(false, `${f}：owner 单元格形状应为 \`路径::符号\`，实得 ${ownerRaw}`);
        continue;
      }
      const [, rel, sym] = m;
      // 数值列要写纯数字：`20_000`、`20 000`、「两万」都会让这一行变成人肉核对。
      ok(/^[0-9]+$/.test(String(valueRaw)),
        `${f}：${sym} 的数值列要写纯数字（实得 ${valueRaw}）`);
      const declared = parseInt(String(valueRaw).replace(/[_,\s]/g, ''), 10);
      ok(Number.isFinite(declared), `${f}：${sym} 的数值列要写纯数字（实得 ${valueRaw}）`);
      let exists = false;
      try {
        fs.accessSync(path.join(ROOT, rel));
        exists = true;
      } catch (e) {
        exists = false;
      }
      if (!exists) {
        ok(false, `${f}：${sym} 指向的文件不存在：${rel}`);
        continue;
      }
      const defs = findDefinition(readSrc(rel), sym);
      if (!defs.length) {
        ok(false, `${f}：在 ${rel} 里找不到常量 ${sym}（改名或删除要同时改这里）`);
        continue;
      }
      const parsed = defs.map(evalLiteral).filter(Boolean);
      if (!parsed.length) {
        ok(false, `${f}：${rel} 里 ${sym} 的定义行读不出字面量（换写法请同时更新本脚本）`);
        continue;
      }
      const same = parsed.some((p) => p.value === declared);
      ok(same, `${f}：${sym} 的数值 ${declared} 与源码不一致（源码里是 ${parsed.map((p) => p.value).join('/')}）`);
      rows += 1;
    }
  }
  ok(rows >= 30, `钉住的边界条目够多（实得 ${rows}）`);
  console.log(`\n核对的边界条目：${rows} 条，覆盖 ${files.length} 篇决策日志`);
  console.log(`ADR 契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
