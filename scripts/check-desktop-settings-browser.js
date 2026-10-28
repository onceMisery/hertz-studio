// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Desktop settings browser contract: drafts, version conflicts, readonly preview and lifecycle.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace('__SETTINGS__', fs.readFileSync(path.join(assets, 'wallpaper-settings.js'), 'utf8'));
const sceneHtml = fs.readFileSync(path.join(assets, 'wallpaper-scene.html'), 'utf8')
  .replace('__RUNTIME__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8'))
  .replace('__SHIM__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/zodiac-stage.js'), 'utf8'))
  .replace('__SCENE__', fs.readFileSync(path.join(assets, 'wallpaper-scene.js'), 'utf8'));
const scenePairs = [...fs.readFileSync(path.join(root, 'crates/hertz-desktop/src/config.rs'), 'utf8').matchAll(/^    \("([a-z-]+)", "([^"]+)"\),$/gm)];
const initial = {
  revision: 9,
  config: { enabled: false, fps: 30, musicResponse: true, monitor: null, source: 'follow', scene: 'zodiac' },
  lyricsConfig: { enabled: true, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null },
  scenes: scenePairs.map(match => ({ id: match[1], label: match[2] })),
  profile: { dataDir: 'D:\\Music\\Hertz', edition: 'full' },
  profiles: [{ dataDir: 'D:\\Music\\Hertz', edition: 'full' }, { dataDir: 'D:\\Music\\Standard', edition: 'standard' }],
  monitors: [{ name: 'DISPLAY1', label: '主屏 · 1920×1080', primary: true }], spaceScene: 'zodiac',
  previewActive: false, launchAtLogin: false, positionEditing: false,
  runtime: { enabled: true, locked: true, visible: false, source: 'ok', userHidden: false, policy: { noContent: true }, wallpaper: { enabled: false, visible: false, hidden: false, fps: 30 }, diagnostics: { pauseReasons: ['disabled'] } },
};
async function main() {
  const server = http.createServer((request, response) => { if (request.url.startsWith('/scene-thumbnails/')) { response.setHeader('Content-Type','image/jpeg'); return response.end(fs.readFileSync(path.join(assets,'scene-thumbnails',path.basename(request.url)))); } response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.url === '/wallpaper.html' ? sceneHtml : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => { window.desktopRequests = []; window.ipc = { postMessage: text => window.desktopRequests.push(JSON.parse(text)) }; });
    await page.goto('http://127.0.0.1:' + server.address().port + '/settings.html');
    assert.equal(await page.locator('#apply').isEnabled(), false);
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), initial);
    assert.equal(await page.locator('[data-scene]').count(), 9);
    await page.waitForFunction(()=>document.querySelector('#scene-static').naturalWidth>0);
    assert.equal(await page.locator('#preview-renderer').count(),0,'Initial static reference must not create a live renderer');
    assert.match(await page.locator('#wallpaper-state').innerText(), /未启用/);
    await page.locator('#tab-lyrics').click();
    await page.locator('[data-preset=translation]').click();
    assert.equal(await page.locator('#lyrics-size').inputValue(),'30');
    assert.equal(await page.locator('#lyrics-weight').inputValue(),'500');
    assert.equal(await page.locator('#lyrics-stroke').inputValue(),'1.5');
    assert.equal(await page.locator('[data-preset=translation]').getAttribute('aria-pressed'),'true');
    await page.locator('#lyrics-size').fill('42');
    assert.equal(await page.locator('[data-preset][aria-pressed=true]').count(),0);
    assert.match(await page.locator('#lyrics-preset-status').innerText(),/自定义/);
    const closeCount=await page.evaluate(()=>window.desktopRequests.filter(request=>request.cmd==='close').length);
    await page.locator('#close').click();
    assert.equal(await page.locator('#close-confirm').isVisible(),true);
    assert.equal(await page.evaluate(()=>window.desktopRequests.filter(request=>request.cmd==='close').length),closeCount);
    await page.locator('#continue-editing').click();
    assert.equal(await page.locator('#lyrics-size').inputValue(),'42');
    await page.evaluate(()=>window.hertzWallpaperSettings.requestClose());
    assert.equal(await page.locator('#close-confirm').isVisible(),true);
    await page.locator('#continue-editing').click();
    assert.equal(await page.locator('#apply').isEnabled(), true);
    assert.equal(await page.locator('#lyrics-secondary').inputValue(), 'translation');
    assert.equal((await page.evaluate(() => window.desktopRequests)).some(request => request.cmd === 'apply' || request.cmd === 'lyrics-apply'), false, 'style preview must not submit changes');
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), initial);
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42', 'polling must preserve dirty input');
    await page.locator('#bg-light').click();
    assert.equal(await page.locator('#lyrics-preview.light').count(), 1);
    await page.locator('#apply').click();
    const apply = await page.evaluate(() => window.desktopRequests.filter(request => request.cmd === 'apply').at(-1));
    assert.equal(apply.expectedRevision, 9); assert.equal(apply.lyrics.fontSize, 42); assert.equal(apply.lyrics.secondary, 'translation'); assert.deepEqual(apply.config, initial.config);
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), { ...initial, error: '保存失败' });
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42');
    assert.equal(await page.locator('#apply').isEnabled(), true);
    const external = structuredClone(initial); external.revision = 10; external.lyricsConfig.fontSize = 35;
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), external);
    assert.equal(await page.locator('#conflict').isVisible(), true);
    assert.equal(await page.locator('#apply').isEnabled(), false);
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42');
    await page.locator('#discard').click();
    assert.equal(await page.locator('#lyrics-size').inputValue(), '35');
    assert.equal(await page.locator('#conflict').isVisible(), false);
    // Editing an incomplete number also survives status refreshes.
    await page.locator('#lyrics-size').fill('');
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), external);
    assert.equal(await page.locator('#lyrics-size').inputValue(), '');
    assert.equal(await page.locator('#apply').isEnabled(), false);
    await page.locator('#discard').click();
    await page.locator('#position-begin').click();
    assert.equal((await page.evaluate(() => window.desktopRequests.at(-1))).cmd, 'position-begin');
    const position = { ...external, positionEditing: true, runtime: { ...external.runtime, visible: true, locked: false } };
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), position);
    assert.equal(await page.locator('#position-session').isVisible(), true);
    assert.equal(await page.locator('#lyrics-size').isEnabled(), false);
    await page.locator('#position-cancel').click();
    assert.equal((await page.evaluate(() => window.desktopRequests.at(-1))).cmd, 'position-cancel');
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), external);
    await page.locator('#tab-wallpaper').click();
    await page.locator('[data-scene=coast]').click();
    assert.equal(await page.locator('#scene-source').inputValue(), 'fixed');
    assert.equal(await page.locator('#scene-fixed').inputValue(), 'coast');
    await page.locator('#preview').click();
    const preview = await page.evaluate(() => window.desktopRequests.at(-1));
    assert.equal(preview.cmd, 'preview'); assert.equal(preview.config.scene, 'coast');
    await page.evaluate(payload => { window.hertzWallpaperSettings.applyStatus(payload); window.hertzWallpaperSettings.mountPreview(); }, { ...external, previewActive: true });
    await page.waitForFunction(() => window.desktopRequests.some(request => request.cmd === 'preview-event' && request.event === 'wallpaper_dom_ready'));
    // This is the same renderer/config/start bridge used by the native preview lease.
    await page.evaluate(() => window.hertzWallpaperSettings.evalPreview("window.hertzWallpaper.applyConfig({source:'fixed',scene:'coast',musicResponse:true}); window.hertzWallpaper.start(15);"));
    await page.waitForFunction(() => document.querySelector('#preview-renderer').contentDocument.querySelector('canvas'));
    await page.waitForTimeout(500);
    const out = path.join(root, 'output/playwright/desktop-settings'); fs.mkdirSync(out, { recursive: true });
    await page.evaluate(() => document.querySelector('main').scrollTop = 0);
    await page.screenshot({ path: path.join(out, 'wallpaper-1120.png') });
    await page.locator('#tab-lyrics').click();
    assert.equal((await page.evaluate(() => window.desktopRequests.at(-1))).cmd, 'preview-close');
    await page.evaluate(() => window.hertzWallpaperSettings.unmountPreview());
    assert.equal(await page.locator('#preview-renderer').count(), 0);
    await page.screenshot({ path: path.join(out, 'lyrics-1120.png') });
    const missing = structuredClone(external); missing.config.monitor = 'DISPLAY9'; missing.runtime.wallpaper = { enabled: true, monitorMissing: true };
    await page.locator('#discard').click();
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), missing);
    await page.locator('#tab-wallpaper').click();
    assert.equal(await page.locator('#monitor').inputValue(), 'DISPLAY9');
    assert.match(await page.locator('#wallpaper-state').innerText(), /未连接/);
    await page.setViewportSize({ width: 390, height: 700 });
    for (const tab of ['wallpaper', 'lyrics', 'runtime']) {
      await page.locator('#tab-' + tab).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at 390px: ' + tab);
      await page.screenshot({ path: path.join(out, tab + '-390.png'), fullPage: true });
    }
    await page.locator('#tab-lyrics').click();
    await page.locator('#lyrics-size').fill('43');
    await page.locator('#close').click();await page.locator('#discard-close').click();
    assert.equal((await page.evaluate(()=>window.desktopRequests.at(-1))).cmd,'close');
    // The detected source is only a candidate when a v1 migration has no binding.
    const unbound = structuredClone(initial); unbound.profile = null; unbound.profiles = [initial.profile];
    await page.evaluate(payload => hertzWallpaperSettings.applyStatus(payload), unbound);
    await page.locator('#tab-runtime').click();
    assert.equal(await page.locator('#switch-source').isEnabled(), true, 'a single unbound candidate can be explicitly selected');
    await page.locator('#switch-source').click();
    const bind = await page.evaluate(() => desktopRequests.at(-1));
    assert.equal(bind.cmd, 'switch-source'); assert.deepEqual(bind.profile, initial.profile); assert.equal(bind.expectedRevision, unbound.revision);
    await page.evaluate(payload => hertzWallpaperSettings.applyStatus(payload), { ...unbound, profile: initial.profile, message: '已切换来源' });
    assert.equal(await page.locator('#switch-source').isDisabled(), true, 'the same source becomes current only after native confirms binding');
    assert.deepEqual(errors, []);
    console.log('desktop settings browser checks passed: draft/apply/discard, dirty close guard, concrete presets/custom, authentic static thumbnails, conflict, readonly real renderer, lease cleanup, position controls, monitor recovery, responsive layout');
    console.log('screenshots: ' + out);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
