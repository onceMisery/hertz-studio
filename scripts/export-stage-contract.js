// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 舞台窄契约导出器（技术路线 R3-K 的第一块：真实场景 fixture）。
//
// 起因与 api-routes 同源：Rust 侧的 intent 校验需要「当前有哪些场景、每个
// 场景有哪些参数」，手写第二份必然漂移（space/coast 假场景就是这么混进来的）。
// 本脚本从 `plugin/ui/creative-gl.js` 的 `CreativeGL.scenes()` 生成版本化
// JSON，落在 `crates/hertz-studio/src/ai/stage-contract/`，由 Rust 侧
// `include_str!` 内嵌。正式物化（无副作用 materializeIntent）仍是 R3-K 的
// 下一块；本导出只覆盖场景身份与参数窄表。
//
// 用法：
//   node scripts/export-stage-contract.js          # 重新生成并写回
//   node scripts/export-stage-contract.js --check  # 只校验，漂移则退出码 1

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'plugin', 'ui', 'creative-gl.js');
const OUT = path.join(
  ROOT,
  'crates',
  'hertz-studio',
  'src',
  'ai',
  'stage-contract',
  'stage-contract.json'
);

function loadScenes() {
  const code = fs.readFileSync(SOURCE, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (!sandbox.window.CreativeGL || !sandbox.window.CreativeGL.scenes) {
    throw new Error('creative-gl.js 未暴露 window.CreativeGL.scenes()');
  }
  return sandbox.window.CreativeGL.scenes();
}

// params 行是 [name, label, min, max, step, ?, default]；窄表只取校验与
// 物化需要的字段，label/unit 这类展示细节不出 Rust 边界。
function narrow(scene) {
  return {
    id: scene.id,
    label: scene.label,
    aliases: scene.aliases || [],
    ownsLyrics: !!scene.ownsLyrics,
    params: (scene.params || []).map((row) => ({
      name: row[0],
      min: typeof row[2] === 'number' ? row[2] : null,
      max: typeof row[3] === 'number' ? row[3] : null,
      default: Object.prototype.hasOwnProperty.call(scene.defaults || {}, row[0])
        ? scene.defaults[row[0]]
        : row[6],
    })),
  };
}

function generate() {
  const doc = {
    version: 1,
    generator: 'scripts/export-stage-contract.js',
    source: 'plugin/ui/creative-gl.js',
    scenes: loadScenes().map(narrow),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

function main() {
  const generated = generate();
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (committed !== generated) {
      console.error(
        '舞台契约与源码不一致（crates/hertz-studio/src/ai/stage-contract/stage-contract.json 是生成物，请跑 node scripts/export-stage-contract.js）'
      );
      process.exit(1);
    }
    console.log(`舞台契约与源码一致（${JSON.parse(generated).scenes.length} 个场景）`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, generated);
  console.log(`已更新 ${path.relative(ROOT, OUT)}（${JSON.parse(generated).scenes.length} 个场景）`);
}

main();
