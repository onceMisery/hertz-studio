#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// check-* 脚本的登记守卫：每个 check-* 必须要么进入 check-frontend 的
// CI/EXTRA/活体清单（或 workflow 直接调用），要么在 manual-checks.json 里
// 显式登记为手工/浏览器检查。新脚本不能再悄悄堆在 scripts/ 里无人运行。
//
//   node scripts/check-scripts.js          # 校验登记完整性
//
// 失败条件：未登记的新脚本、manual 指向已删除文件、manual 与聚合入口重叠、
// 入口指向不存在的 check-*、manual 条目缺少用途。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANUAL_FILE = path.join(__dirname, 'manual-checks.json');
const FRONTEND = path.join(__dirname, 'check-frontend.js');
const SELF = 'check-scripts.js';
const AGGREGATE = 'check-frontend.js';

function registryFromFrontend() {
  const source = fs.readFileSync(FRONTEND, 'utf8');
  const names = new Set();
  for (const array of ['STEPS', 'EXTRA', 'LIVE_EXTRA']) {
    const start = source.indexOf('const ' + array + ' = [');
    if (start < 0) continue;
    let i = source.indexOf('[', start), depth = 0, end = -1;
    for (; i < source.length; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') {
        depth--;
        if (!depth) { end = i; break; }
      }
    }
    for (const match of source.slice(start, end).matchAll(/'([A-Za-z0-9_.-]+\.(?:js|cjs|mjs))'/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function registryFromWorkflows() {
  const dir = path.join(ROOT, '.github', 'workflows');
  const names = new Set();
  for (const file of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/scripts\/([A-Za-z0-9_.-]+\.(?:js|cjs|mjs|py))/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function main() {
  const files = new Set(fs.readdirSync(__dirname)
    .filter(f => /^check-.*\.(js|cjs|mjs|py)$/.test(f) && f !== AGGREGATE && f !== SELF));
  const registered = new Set([...registryFromFrontend(), ...registryFromWorkflows()]);
  const doc = JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
  const errors = [];
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.scripts)) {
    errors.push('manual-checks.json 结构不合法');
  }
  const manual = new Map();
  for (const entry of doc.scripts || []) {
    if (!entry || typeof entry.script !== 'string') {
      errors.push('manual-checks.json 含非法条目');
      continue;
    }
    if (manual.has(entry.script)) errors.push('manual 重复登记: ' + entry.script);
    if (typeof entry.purpose !== 'string' || !entry.purpose.trim()) {
      errors.push('manual 条目缺少用途: ' + entry.script);
    }
    manual.set(entry.script, entry);
  }
  for (const name of files) {
    if (!registered.has(name) && !manual.has(name)) errors.push('未登记的 check-*: ' + name);
  }
  for (const name of manual.keys()) {
    if (!files.has(name)) errors.push('manual 指向缺失脚本: ' + name);
    if (registered.has(name)) errors.push('已进入聚合入口，请从 manual 移除: ' + name);
  }
  for (const name of registered) {
    if (name.startsWith('check-') && name !== AGGREGATE && name !== SELF && !files.has(name)) {
      errors.push('聚合入口指向缺失脚本: ' + name);
    }
  }
  const registeredChecks = [...files].filter(f => registered.has(f)).length;
  if (errors.length) {
    console.error('脚本登记检查失败：');
    errors.forEach(error => console.error('  - ' + error));
    console.error(`共 ${files.size} 个 check-*：${registeredChecks} 个在聚合入口，${manual.size} 个手工登记。`);
    process.exitCode = 1;
    return;
  }
  console.log(`脚本登记通过：${files.size} 个 check-*，${registeredChecks} 个在聚合入口，${manual.size} 个手工登记。`);
}

main();
