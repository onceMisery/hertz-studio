// SPDX-License-Identifier: MIT
// Authenticate the real isolated service while serving this checkout's UI sources.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readAssets } = require('./ui-assets');
const web = path.resolve(__dirname, '../plugin/ui');

async function routeSourceAssets(page, fixture) {
  await page.context().grantPermissions(['local-network-access'], { origin: fixture.base });
  const assets = new Map(readAssets().map(asset => [asset.path, asset]));
  const { token } = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8'));
  await page.route(fixture.base + '/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', token),
    });
    const asset = assets.get(url.pathname);
    if (asset) return route.fulfill({ path: asset.file,
      contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css' });
    return route.fallback();
  });
}

module.exports = { routeSourceAssets };
