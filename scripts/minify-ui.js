#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('../tools/space-stage/node_modules/esbuild');
const SOURCE_UI_ROOT = path.resolve(__dirname, '../plugin/ui');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function resolveTarget(directory) {
  const target = fs.realpathSync(directory);
  if (!fs.statSync(target).isDirectory()) throw new Error(`UI target is not a directory: ${directory}`);
  const source = fs.realpathSync(SOURCE_UI_ROOT);
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error(`Refusing to minify a directory that overlaps plugin/ui source: ${directory}`);
  }
  return target;
}

// Only staged release output is transformed. Keep global names and classic scripts.
function minifyUi(directory) {
  directory = resolveTarget(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) minifyUi(file);
    else if (/\.(js|css)$/.test(entry.name)) {
      const original = fs.readFileSync(file, 'utf8');
      // Ordinary // copyright/SPDX headers are not esbuild "legal comments".
      // Preserve that leading notice verbatim (including qrcode's attribution).
      const header = original.match(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/)?.[0] || '';
      const banner = /SPDX-License|copyright|licensed under/i.test(header) ? header.trimEnd() : '';
      const { code } = esbuild.transformSync(original, {
        loader: entry.name.endsWith('.css') ? 'css' : 'js', target: 'es2020',
        minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false,
        charset: 'utf8', legalComments: 'eof', banner,
      });
      fs.writeFileSync(file, code);
    }
  }
}
if (require.main === module) {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: node scripts/minify-ui.js output/editions/{standard|full}/plugin/ui');
  const targetPath = path.resolve(argument);
  const editionsRoot = path.resolve(__dirname, '../output/editions');
  const relative = path.relative(editionsRoot, targetPath).split(path.sep);
  const isReleaseUi = ['standard', 'full'].includes(relative[0]?.toLowerCase())
    && relative.slice(1).join('/').toLowerCase() === 'plugin/ui';
  if (!isReleaseUi) throw new Error('Only output/editions/{standard|full}/plugin/ui may be minified by this CLI.');
  const expectedTarget = fs.realpathSync(path.join(editionsRoot, relative[0], 'plugin', 'ui'));
  const target = resolveTarget(targetPath);
  if (target !== expectedTarget) throw new Error('Only output/editions/{standard|full}/plugin/ui may be minified by this CLI.');
  minifyUi(target);
}
module.exports = { minifyUi };
