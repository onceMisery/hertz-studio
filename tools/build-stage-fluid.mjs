// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors.
// Build this separately: the Canvas UI derivative retains its own license.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'tools/space-stage/package.json'));
const { build } = require('esbuild');
const license = readFileSync(resolve(root, 'tools/stage-fluid/LICENSE.md'), 'utf8').trim();
const output = resolve(root, 'plugin/ui/vendor/stage-fluid.js');
const manifestPath = resolve(root, 'tools/stage-fluid/.build-manifest.json');
const banner = `/*!\n * Canvas UI fluid solver, adapted for Hertz Studio.\n * Upstream: DavidHDev/canvas-ui a04a99b235299ee79a123a16ccb2e6cf9da74b6b.\n * SPDX-License-Identifier: LicenseRef-CanvasUI-Commons-Clause\n * ${license.replace(/\n/g, '\n * ')}\n */`;
const result = await build({ entryPoints: [resolve(root, 'tools/stage-fluid/src/main.js')],
  bundle: true, format: 'iife', globalName: 'HertzFluidEngine', target: 'es2018',
  minify: true, legalComments: 'none', banner: { js: banner }, write: false });
const code = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== code) throw new Error('Fluid bundle is stale; run node tools/build-stage-fluid.mjs');
  console.log('Fluid bundle and license match their sources.');
} else {
  writeFileSync(output, code);
  console.log(`Built ${output} (${Buffer.byteLength(code)} bytes; sha256 ${createHash('sha256').update(code).digest('hex').slice(0,16)}).`);
}
const inputs = ['tools/build-stage-fluid.mjs', 'tools/stage-fluid/LICENSE.md',
  'tools/stage-fluid/src/main.js', 'tools/stage-fluid/src/shaders.js', 'plugin/ui/vendor/stage-fluid.js'];
const manifest = JSON.stringify(Object.fromEntries(inputs.sort().map(file => [file,
  createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex').slice(0, 16)])), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('Fluid manifest is stale; run node tools/build-stage-fluid.mjs');
} else writeFileSync(manifestPath, manifest);
