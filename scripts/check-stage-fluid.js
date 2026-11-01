#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Shipping/ownership guard. Pixel and lifecycle behavior live in browser checks.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { createHash } = require('node:crypto');
const manifest = JSON.parse(read('tools/stage-fluid/.build-manifest.json'));
for (const [file, expected] of Object.entries(manifest)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 16), expected,
    file + ' is stale; run node tools/build-stage-fluid.mjs');
}
const license = read('tools/stage-fluid/LICENSE.md').trim();
const bundle = read('plugin/ui/vendor/stage-fluid.js');
const header = bundle.slice(0, bundle.indexOf('*/')).split('\n').slice(1).map(line => line.replace(/^ \* ?/, '')).join('\n');
assert.ok(header.includes(license), 'shipping bundle retains the complete upstream terms');
assert.ok(header.includes('a04a99b235299ee79a123a16ccb2e6cf9da74b6b'));
assert.ok(header.includes('LicenseRef-CanvasUI-Commons-Clause'));
assert.ok(!read('plugin/ui/vendor/stage-runtime.js').includes('HertzFluidEngine'), 'restricted source stays outside MIT shared runtime');
for (const file of ['tools/stage-fluid/src/main.js', 'tools/stage-fluid/src/shaders.js']) {
  assert.ok(read(file).startsWith('// SPDX-License-Identifier: LicenseRef-CanvasUI-Commons-Clause'));
}
const scope = {}; vm.runInNewContext(bundle, scope);
assert.deepEqual(Object.keys(scope).sort(), ['HertzFluidEngine'], 'engine evaluation creates no DOM, scheduler or graphics resources');
for (const [tier, expected] of [[2, [20, 64, 128, 1000000]]]) {
  const profile = scope.HertzFluidEngine.profiles[tier];
  assert.deepEqual([profile.fps, profile.simulation, profile.dye, profile.pixels], expected);
  assert.ok(Object.isFrozen(profile));
}
assert.equal(scope.HertzFluidEngine.profiles[0], undefined);
assert.equal(scope.HertzFluidEngine.profiles[1], undefined, 'balanced is not admitted before its frame budget passes');
for (const file of ['plugin/ui/stage-fluid.js', 'tools/stage-fluid/src/main.js']) {
  assert.ok(!/requestAnimationFrame|setInterval|setTimeout|captureStream|captureElement|texImage2D\([^)]*image/i.test(read(file)), file + ' cannot acquire independent clocks or DOM capture');
}
const index = read('plugin/ui/index.html'), assets = read('crates/hertz-studio/src/assets.rs');
for (const file of ['stage-fluid.js', 'vendor/stage-fluid.js']) {
  assert.ok(index.includes('src="' + file + '"'));
  assert.ok(assets.includes('"' + file + '"'));
}
assert.ok(index.indexOf('src="vendor/stage-fluid.js"') < index.indexOf('src="stage-fluid.js"'));
assert.ok(index.indexOf('src="stage-fluid.js"') < index.indexOf('src="app.js"'));
assert.ok(read('NOTICE').includes('tools/stage-fluid/LICENSE.md'));
console.log('Stage fluid: complete license, isolated bundle, inert evaluation, bounded profiles, single-clock ownership and both asset registrations passed.');
