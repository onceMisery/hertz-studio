'use strict';
// Read the production registry, rather than maintaining a second asset list.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'crates/hertz-studio/src/assets.rs');
function readAssets(source = fs.readFileSync(FILE, 'utf8')) {
  return Array.from(source.matchAll(/"(\/[^"\s]+)"\s*,\s*(JS|CSS|HTML)\s*=>\s*const\s+(\w+)\s*:\s*&str\s*=\s*edition_ui!\(\s*"([^"]+)"\s*\)\s*;/g), m => {
    // Authored splash documents live at the repository root and are copied to
    // the same path in every generated UI package by edition-ui.rs.
    const file = path.resolve(ROOT, m[4].startsWith('splash/') ? '.' : 'plugin/ui', m[4]);
    return {
      path: m[1], mime: m[2], name: m[3], packaged: m[4], file,
      rel: path.relative(path.join(ROOT, 'crates/hertz-studio/src'), file).split(path.sep).join('/'),
    };
  });
}
function hasAsset(route) {
  const item = readAssets().find(a => a.path === route);
  return !!item && fs.existsSync(item.file);
}
module.exports = { readAssets, hasAsset, FILE };
