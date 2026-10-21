#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const BASE_ID = 'io.github.oncemisery.hertz-studio';

function prepare(edition) {
  if (!['standard', 'full'].includes(edition)) throw new Error('edition must be standard or full');
  const full = edition === 'full';
  const dest = path.join(ROOT, 'output', 'editions', edition, 'plugin');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'backend'), { recursive: true });
  const helper = path.join(path.dirname(dest), 'edition-ui' + (process.platform === 'win32' ? '.exe' : ''));
  execFileSync('rustc', ['--edition=2021', path.join(ROOT, 'build-support/edition-ui.rs'), '-o', helper], { stdio: 'inherit' });
  execFileSync(helper, [path.join(ROOT, 'plugin/ui'), path.join(dest, 'ui'), edition], { stdio: 'inherit' });
  require('./minify-ui').minifyUi(path.join(dest, 'ui'));
  fs.cpSync(path.join(ROOT, 'plugin/assets'), path.join(dest, 'assets'), { recursive: true });
  const sdk = path.join(dest, 'sdk-root/plugins/sdk/rust/dbx-plugin-sdk');
  fs.cpSync(path.join(ROOT, 'plugin/vendor/dbx-plugin-sdk'), sdk, { recursive: true });

  // Rewrite identifiers in keys and values together, including localization keys.
  function rewrite(value) {
    if (typeof value === 'string') {
      return value.replaceAll(BASE_ID, full ? BASE_ID + '.full' : BASE_ID)
        .replaceAll('Hertz Studio', 'Hertz Studio ' + (full ? 'Full' : 'Standard'));
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [rewrite(key), rewrite(item)]));
    return value;
  }
  const manifest = rewrite(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/manifest.json'), 'utf8')));
  manifest.name = 'Hertz Studio ' + (full ? 'Full' : 'Standard');
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: ROOT, encoding: 'utf8' }));
  const backend = metadata.packages.find(p => p.name === 'dbx-plugin-hertz');
  if (backend.version !== manifest.version) throw new Error('Cargo and plugin versions differ');
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'plugin/dbx-plugin.toml'), path.join(dest, 'dbx-plugin.toml'));

  // CLI 0.1.2 has no Cargo feature flag. A generated wrapper selects the shared
  // library feature explicitly and compiles the original sidecar entrypoint.
  const quote = s => JSON.stringify(s.replaceAll('\\', '/'));
  const dependencies = backend.dependencies.map(d => {
    const options = d.path ? [`path = ${quote(d.name === 'dbx-plugin-sdk' ? sdk : d.path)}`] : [`version = ${quote(d.req)}`];
    const features = [...d.features, ...(full && d.name === 'hertz-studio' ? ['full'] : [])];
    if (features.length) options.push(`features = ${JSON.stringify(features)}`);
    if (!d.uses_default_features) options.push('default-features = false');
    return `${d.name} = { ${options.join(', ')} }`;
  });
  const releaseProfile = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8').split('[profile.release]')[1];
  fs.writeFileSync(path.join(dest, 'backend/Cargo.toml'), [
    '[workspace]', '[package]', 'name = "dbx-plugin-hertz"', `version = ${quote(backend.version)}`,
    'edition = "2021"', '[[bin]]', 'name = "dbx-plugin-hertz"',
    `path = ${quote(path.join(ROOT, 'plugin/backend/src/main.rs'))}`, '[dependencies]', ...dependencies,
    releaseProfile ? '[profile.release]' + releaseProfile : '', ''
  ].join('\n'));
  fs.copyFileSync(path.join(ROOT, 'Cargo.lock'), path.join(dest, 'backend/Cargo.lock'));
  // Prune workspace-only entries while retaining the checked-in dependency pins.
  execFileSync('cargo', ['update', '--workspace', '--manifest-path',
    path.join(dest, 'backend/Cargo.toml'), '--config',
    'patch.crates-io.dbx-plugin-sdk.path=' + quote(sdk)],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  return dest;
}

if (require.main === module) console.log(prepare(process.argv[2] || 'standard'));
module.exports = { prepare };
