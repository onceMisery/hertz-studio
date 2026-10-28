#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { prepare } = require('./prepare-edition');
const root = path.resolve(__dirname, '..');
const staged = {};
for (const edition of ['standard', 'full']) {
  const dir = prepare(edition);
  staged[edition] = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'ui/index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)) {
    assert(fs.existsSync(path.join(dir, 'ui', match[1])), edition + ': missing ' + match[1]);
  }
  function checkScripts(dir) {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, file.name);
      if (file.isDirectory()) checkScripts(absolute);
      else if (file.name.endsWith('.js')) new vm.Script(fs.readFileSync(absolute, 'utf8'), { filename: absolute });
    }
  }
  checkScripts(path.join(dir, 'ui'));
  for (const file of ['online-login.js', 'vendor/qrcode.js', 'platform-icons']) {
    assert.equal(fs.existsSync(path.join(dir, 'ui', file)), edition === 'full', edition + ': ' + file);
  }
  for (const id of ['online-account-btn', 'qr-modal', 'set-scrobble']) {
    assert.equal(html.includes('id="' + id + '"'), edition === 'full', edition + ': ' + id);
  }
  const backend = fs.readFileSync(path.join(dir, 'backend/Cargo.toml'), 'utf8');
  assert.equal(backend.includes('features = ["full"]'), edition === 'full');
  assert(!html.includes('edition:'));
  assert.equal(staged[edition].version, '0.3.0');
  for (const item of staged[edition].contributions) assert(item.id.startsWith(staged[edition].id + '.'));
  for (const locale of Object.values(staged[edition].localizations)) {
    assert(locale.name.includes(edition === 'full' ? 'Full' : 'Standard'));
    for (const id of Object.keys(locale.contributions)) assert(id.startsWith(staged[edition].id + '.'));
  }
}
assert.notEqual(staged.standard.id, staged.full.id);
assert.equal(staged.standard.version, staged.full.version);

// Specific protocol fingerprints, rather than incidental platform labels in comments.
const fingerprints = ['0CoJUm6Qyw8W8jud', 'e82ckenh8dichen8', 'wx48db31d50e334801',
  'https://u.y.qq.com/cgi-bin/musicu.fcg', 'https://wwwapi.kugou.com/play/songinfo'];
if (process.env.HERTZ_STANDARD_BIN) {
  const binary = fs.readFileSync(process.env.HERTZ_STANDARD_BIN);
  for (const text of fingerprints) assert(!binary.includes(Buffer.from(text)), 'Standard contains ' + text);
}
const release = fs.readFileSync(path.join(root, '.github/workflows/plugin-release.yml'), 'utf8');
assert(release.includes('hertz-plugin-standard-v${version}'));
assert(release.includes('HERTZ_EDITION=standard PLUGIN_RELEASE=1'));
const markerTests = path.join(root, 'output/editions/edition-ui-tests' + (process.platform === 'win32' ? '.exe' : ''));
execFileSync('rustc', ['--edition=2021', '--test', path.join(root, 'build-support/edition-ui.rs'), '-o', markerTests]);
execFileSync(markerTests, [], { stdio: 'inherit' });
console.log('Edition staging: both UIs parse, source assets and identities are isolated, versions match.');
