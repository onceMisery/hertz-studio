#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { minifyUi } = require('./minify-ui');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-release-ui-'));
const digest = text => createHash('sha256').update(text).digest('hex');
try {
  const source = path.join(root, 'plugin/ui');
  const before = digest(fs.readFileSync(path.join(source, 'creative-stage.js')));
  assert.throws(() => minifyUi(source), /overlaps plugin\/ui source/);
  const sourceCli = spawnSync(process.execPath, [path.join(root, 'scripts/minify-ui.js'), source], { encoding: 'utf8' });
  assert.notEqual(sourceCli.status, 0, 'CLI rejects source trees');
  assert.match(sourceCli.stderr, /Only output\/editions/);
  fs.writeFileSync(path.join(temp, 'first.js'), '// SPDX-License-Identifier: MIT\n// Copyright Fixture Author\nvar PublicAPI = { answer: 42 };\nlet sharedLexical = 7;\n');
  fs.writeFileSync(path.join(temp, 'second.js'), 'window.result = PublicAPI.answer + sharedLexical;\n');
  fs.writeFileSync(path.join(temp, 'style.css'), '/* layout */\nbody { color: rgb(255, 0, 0); --custom-value: 12; }');
  minifyUi(temp);
  assert.match(fs.readFileSync(path.join(temp, 'first.js'), 'utf8'), /Copyright Fixture Author/, 'Ordinary legal notice survives release minification');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const file of ['first.js', 'second.js']) vm.runInContext(fs.readFileSync(path.join(temp, file), 'utf8'), sandbox);
  assert.equal(sandbox.window.result, 49, 'Classic global and cross-script lexical names survive');
  assert.equal(digest(fs.readFileSync(path.join(source, 'creative-stage.js'))), before, 'Source remains readable');
  const runtime = fs.readFileSync(path.join(source, 'vendor/stage-runtime.js'), 'utf8');
  assert.ok(Buffer.byteLength(runtime) < 1.1 * 1024 * 1024, 'Shared runtime budget includes Three.js and all scenes');
  assert.ok(!/\beval\s*\(|new Function\s*\(|\bimport\s*\(/.test(runtime), 'No eval or dynamic modules under plugin CSP');
  const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  for (const id of ['coast', 'zodiac', 'space']) {
    assert.ok(html.indexOf('vendor/stage-runtime.js') >= 0);
    assert.ok(html.indexOf('vendor/stage-runtime.js') < html.indexOf(`vendor/${id}-stage.js`));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, `tools/${id}-stage/.build-manifest.json`)));
    for (const [file, hash] of Object.entries(manifest)) assert.equal(digest(fs.readFileSync(path.join(root, file))).slice(0, 16), hash, file);
  }
  console.log('Release UI: classic globals, cross-script lexical names, source preservation, CSP, runtime budget, dependency order and all generated hashes passed.');
  if (process.argv[2]) {
    const embedded = path.resolve(process.argv[2]);
    const full = process.argv.includes('--full');
    let resources = 0, identityBytes = 0, gzipBytes = 0;
    for (const entry of require('./ui-assets').readAssets()) {
      if (!full && ['/online-login.js', '/vendor/qrcode.js'].includes(entry.path)) continue;
      const file = path.join(embedded, entry.path.slice(1));
      const identity = fs.readFileSync(file), gzip = fs.readFileSync(file + '.gz');
      assert.deepEqual(zlib.gunzipSync(gzip), identity, entry.path + ' build-time gzip round-trip');
      resources++; identityBytes += identity.length; gzipBytes += gzip.length;
    }
    console.log(JSON.stringify({ edition: full ? 'full' : 'standard', resources, identityBytes, gzipBytes, embedded }));
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
