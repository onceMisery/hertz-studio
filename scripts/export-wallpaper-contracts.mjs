#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 从 tools/space-stage 的真实内置注册定义导出壁纸合同（设计 §3.2/§5.2）：
// 只遍历纯定义 metadata（不创建 canvas/renderer、不执行资源加载或第三方代码）。
// registryHash 对文件内 `scenes` 值的原始字节求 SHA-256，与
// crates/hertz-wallpaper/src/catalog.rs 共用同一字节段契约。
// 用法：node scripts/export-wallpaper-contracts.mjs [--check]
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'crates/hertz-wallpaper/contracts/catalog.json');
const budgetTarget = path.join(root, 'crates/hertz-wallpaper/contracts/gl-budgets.json');
let budgets;

function loadCatalog() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'tools/space-stage/.build-manifest.json'), 'utf8'),
  );
  for (const [file, expected] of Object.entries(manifest)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 16);
    if (actual !== expected) throw new Error('Stale space bundle: ' + file);
  }
  const bundle = fs.readFileSync(path.join(root, 'plugin/ui/vendor/space-stage.js'), 'utf8');
  const sandbox = { Math, console, AbortController, setTimeout, clearTimeout, JSON };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const api = vm.runInNewContext(
    fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8') +
      '\n' + bundle + ';SpaceStagePure',
    sandbox,
    { timeout: 15000 },
  );
  const catalog = api.catalog();
  budgets = Object.fromEntries(['low', 'medium', 'high'].map(quality => [quality, {
    pixelBudget: Math.max(api.qualityProfiles[quality].pixelBudget, sandbox.HertzStageRuntime.ZodiacStagePure.qualityProfiles[quality].budget),
    gpuBytes: api.qualityProfiles[quality].memoryBytes,
  }]));
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('registry catalog is empty');
  // 只保留纯 metadata 字段；create/迁移函数等实现体永不进入合同。
  return catalog.map(def => ({
    id: def.id,
    label: def.label,
    category: def.category,
    stateVersion: def.stateVersion,
    aliases: def.aliases,
    preview: def.preview,
    params: def.params,
    camera: def.camera,
    capabilities: def.capabilities,
    quality: def.quality,
  }));
}

function buildFile(scenes) {
  // 先序列化 scenes 数组并对其字节求哈希，再把同一字节串原样拼进文件——
  // 两侧（JS 导出器 / Rust 校验器）对「scenes 的原始字节」达成一致。
  const scenesJson = JSON.stringify(scenes);
  const registryHash = createHash('sha256').update(scenesJson, 'utf8').digest('hex');
  const file = '{\n  "schemaVersion": 1,\n  "registryHash": "' + registryHash + '",\n  "scenes": ' + scenesJson + '\n}\n';
  return { file, registryHash };
}

function main() {
  const check = process.argv.includes('--check');
  const scenes = loadCatalog();
  const { file, registryHash } = buildFile(scenes);
  const budgetFile = JSON.stringify(budgets, null, 2) + '\n';
  if (check) {
    const current = fs.readFileSync(target, 'utf8');
    if (current !== file || fs.readFileSync(budgetTarget, 'utf8') !== budgetFile) {
      console.error('wallpaper contract is stale; run: node scripts/export-wallpaper-contracts.mjs');
      process.exit(1);
    }
    console.log('wallpaper contract check passed: registryHash=' + registryHash + ' scenes=' + scenes.length);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file);
  fs.writeFileSync(budgetTarget, budgetFile);
  console.log('wallpaper contract written: registryHash=' + registryHash + ' scenes=' + scenes.length);
}

main();
