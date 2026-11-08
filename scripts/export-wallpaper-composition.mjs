#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One exact definitions byte segment, shared with the Rust catalog verifier.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { nodeDefinitions, compositionInputs } from '../tools/space-stage/src/nodes/definitions.js';
import { effectDefinitions } from '../tools/space-stage/src/nodes/effect-definitions.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = JSON.stringify({ nodes: nodeDefinitions, effects: effectDefinitions, inputs: compositionInputs });
const hash = createHash('sha256').update(definitions).digest('hex');
const file = '{\n  "schemaVersion": 1,\n  "registryHash": "' + hash + '",\n  "definitions": ' + definitions + '\n}\n';
const target = path.join(root, 'crates/hertz-wallpaper/contracts/composition.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== file) throw new Error('Composition contract is stale; run node scripts/export-wallpaper-composition.mjs');
  const sandbox = { Math, JSON, console, AbortController, setTimeout, clearTimeout };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const built = vm.runInNewContext(fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8')
    + ';HertzStageRuntime.SpaceStagePure.compositionCatalog()', sandbox, { timeout: 15000 });
  if (JSON.stringify(built) !== definitions) throw new Error('Built Stage composition declarations do not match the current source');
} else fs.writeFileSync(target, file);
console.log('Composition metadata ' + (process.argv.includes('--check') ? 'verified' : 'exported') + ': 7 nodes, 5 effects, ' + hash);
