#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Reproducible controlled UI-only packaging comparison (no sidecar/exe claims).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/resource-optimization-20261021');
fs.mkdirSync(output, { recursive: true });
const baselineSource = path.join(output, 'baseline-source');
fs.rmSync(baselineSource, { recursive: true, force: true });
fs.cpSync(path.join(root, 'plugin/ui'), baselineSource, { recursive: true });
fs.rmSync(path.join(baselineSource, 'vendor/stage-runtime.js'));
const index = path.join(baselineSource, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/<script defer src="vendor\/stage-runtime\.js"><\/script>\r?\n/, ''));
for (const id of ['coast', 'zodiac', 'space']) {
  fs.writeFileSync(path.join(baselineSource, `vendor/${id}-stage.js`), execFileSync('git', ['show', `HEAD:plugin/ui/vendor/${id}-stage.js`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }));
}
const helperSource = path.join(output, 'baseline-edition-ui.rs');
fs.writeFileSync(helperSource, execFileSync('git', ['show', 'HEAD:build-support/edition-ui.rs'], { cwd: root }));
const helper = path.join(output, 'baseline-edition-ui' + (process.platform === 'win32' ? '.exe' : ''));
execFileSync('rustc', ['--edition=2021', helperSource, '-o', helper]);
function stats(directory) {
  const result = { files: 0, bytes: 0, jsCssBytes: 0, jsCssGzipBytes: 0, html: [] };
  for (const file of fs.readdirSync(directory, { recursive: true })) {
    const absolute = path.join(directory, file);
    if (!fs.statSync(absolute).isFile()) continue;
    const bytes = fs.readFileSync(absolute);
    result.files++; result.bytes += bytes.length;
    if (/\.(js|css)$/.test(file)) { result.jsCssBytes += bytes.length; result.jsCssGzipBytes += zlib.gzipSync(bytes, { level: 9 }).length; }
    if (file.endsWith('.html')) result.html.push(file);
  }
  return result;
}
const report = { date: '2026-10-21', baselineRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), scope: 'UI-only controlled comparison: current readable source held constant except stage bundles restored from HEAD; baseline edition generator from HEAD. ZIPs contain only UI, no sidecar. gzip byte sums are resource totals, not executable measurements.', editions: {} };
for (const edition of ['standard', 'full']) {
  const beforeDir = path.join(output, `baseline-${edition}`);
  fs.rmSync(beforeDir, { recursive: true, force: true });
  execFileSync(helper, [baselineSource, beforeDir, edition]);
  const afterDir = path.join(root, `output/editions/${edition}/plugin/ui`);
  if (!fs.existsSync(afterDir)) throw new Error('Run node scripts/check-editions.js first');
  const before = stats(beforeDir), after = stats(afterDir);
  const archiveScript = 'import pathlib,zipfile,sys\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:\n for p in sorted(root.rglob("*")):\n  if p.is_file():\n   info=zipfile.ZipInfo(p.relative_to(root).as_posix(),(2026,10,21,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,p.read_bytes(),compresslevel=9)';
  for (const [label, directory, result] of [['before', beforeDir, before], ['after', afterDir, after]]) {
    const archive = path.join(output, `${edition}-ui-${label}.zip`);
    execFileSync('python', ['-c', archiveScript, directory, archive]);
    result.zipBytes = fs.statSync(archive).size;
  }
  report.editions[edition] = { before, after, savedBytes: before.bytes - after.bytes, savedZipBytes: before.zipBytes - after.zipBytes };
}
const baselineBundles = ['coast', 'zodiac', 'space'].reduce((sum, id) => sum + fs.statSync(path.join(baselineSource, `vendor/${id}-stage.js`)).size, 0);
const sharedBundles = ['stage-runtime.js', 'coast-stage.js', 'zodiac-stage.js', 'space-stage.js'].reduce((sum, file) => sum + fs.statSync(path.join(root, 'plugin/ui/vendor', file)).size, 0);
report.stageBundles = { before: baselineBundles, after: sharedBundles, saved: baselineBundles - sharedBundles };
report.releaseEmbedding = {};
for (const edition of ['standard', 'full']) {
  const directory = path.join(output, `release-embedded-${edition}/ui`);
  if (!fs.existsSync(directory)) continue;
  let identityBytes = 0, gzipBytes = 0, resources = 0;
  for (const file of fs.readdirSync(directory, { recursive: true }).filter(file => /\.(js|css)$/.test(file))) {
    const identity = fs.readFileSync(path.join(directory, file));
    const gzip = fs.readFileSync(path.join(directory, file + '.gz'));
    if (!zlib.gunzipSync(gzip).equals(identity)) throw new Error('Invalid embedded gzip: ' + file);
    identityBytes += identity.length; gzipBytes += gzip.length; resources++;
  }
  report.releaseEmbedding[edition] = { resources, identityBytes, gzipBytes, note: 'Actual build.rs PROFILE=release output; compressed-only resource bytes, not linked executable size.' };
}
fs.writeFileSync(path.join(output, 'release-ui-measurements.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
