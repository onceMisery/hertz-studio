// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vendor = path.resolve(__dirname, '../plugin/ui/vendor');
const files = new Map([
  ['/vendor/stage-runtime.js', 'text/javascript'],
  ['/vendor/stage-assets/basis_transcoder.js', 'text/javascript'],
  ['/vendor/stage-assets/basis_transcoder.wasm', 'application/wasm'],
  ['/vendor/stage-assets/phoenix-reference-data.json', 'application/json'],
]);

// Same fixed resources as the native wallpaper protocol. Install on a context
// to cover every page in a multi-page suite, including deferred scene assets.
async function routeStageRuntime(target) {
  await target.route('**/vendor/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const contentType = files.get(pathname);
    if (!contentType) return route.fallback();
    return route.fulfill({ contentType, headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(path.join(vendor, pathname.slice('/vendor/'.length))) });
  });
}
async function runtimePage(browser, options) {
  const page = await browser.newPage(options);
  await routeStageRuntime(page);
  return page;
}
module.exports = { routeStageRuntime, runtimePage };
