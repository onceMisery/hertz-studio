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
const html = fs.readFileSync(path.join(assets, 'wallpaper-settings.html'), 'utf8').replace('__SETTINGS__', fs.readFileSync(path.join(assets, 'wallpaper-settings.js'), 'utf8')).replace('__LIBRARY__', fs.readFileSync(path.join(assets, 'wallpaper-library.js'), 'utf8'));
const sceneHtml = fs.readFileSync(path.join(assets, 'wallpaper-scene.html'), 'utf8')
  .replace('__RUNTIME__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8'))
  .replace('__SHIM__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/zodiac-stage.js'), 'utf8'))
  .replace('__SCENE__', fs.readFileSync(path.join(assets, 'wallpaper-scene.js'), 'utf8'));
const scenePairs = [...fs.readFileSync(path.join(root, 'crates/hertz-desktop/src/config.rs'), 'utf8').matchAll(/^    \("([a-z-]+)", "([^"]+)"\),$/gm)];
const initial = {
  revision: 9,
  config: { enabled: false, audioInput: { kind: 'hertz', gain: 1, attackMs: 40, releaseMs: 250 }, batteryPolicy: 'pause', pauseOnFullscreen: true, pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'main', mode: 'single', displays: [{ kind: 'primary' }], selection: { kind: 'followHertz', idleBuiltin: { sceneId: 'zodiac', stateVersion: 1, params: {} } }, presentation: { fps: 30, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} }] },
  lyricsConfig: { enabled: true, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null },
  scenes: scenePairs.map(match => ({ id: match[1], label: match[2] })),
  profile: { dataDir: 'D:\\Music\\Hertz', edition: 'full' },
  profiles: [{ dataDir: 'D:\\Music\\Hertz', edition: 'full' }, { dataDir: 'D:\\Music\\Standard', edition: 'standard' }],
  monitors: [{ name: 'DISPLAY1', displayId: 'monitor-1', label: '主屏 · 1920×1080', primary: true }], spaceScene: 'zodiac',
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
    await page.addInitScript(() => {
      window.desktopRequests = []; window.nativeTestRevision = 9; window.nativeTestDraft = null;
      window.nativeLibraryWorks = [
        { workKey:'image-work', title:'图片 <img src=x onerror=alert(1)>', kind:'image' },
        { workKey:'video-work', title:'本地视频', kind:'video' },
      ];
      window.ipc = { postMessage: text => {
        const request = JSON.parse(text); window.desktopRequests.push(request);
        if (request.protocol !== 2 || request.command === 'wallpaper.apply') return;
        let result;
        if (request.command === 'wallpaper.draft.create') result = window.nativeTestDraft = { kind: 'settings', draftId: 'browser-draft', draftRevision: 1, baseRevision: window.nativeTestRevision };
        if (request.command === 'wallpaper.draft.update') result = window.nativeTestDraft = { ...window.nativeTestDraft, draftRevision: window.nativeTestDraft.draftRevision + 1 };
        if (request.command === 'wallpaper.draft.discard') { window.nativeTestDraft = null; result = { discarded: true }; }
        if (request.command === 'wallpaper.preview.acquire') result = { leaseId: 'browser-lease', generation: 1, expiresInMs: 15000 };
        if (request.command === 'wallpaper.preview.release') result = { released: true };
        if (request.command === 'wallpaper.library.list') result = { works:window.nativeLibraryWorks, nextCursor:null };
        if (request.command === 'wallpaper.library.get') result = { work:window.nativeLibraryWorks.find(work=>work.workKey===request.payload.workKey), versions:[{version:3,state:'installed',packageHash:request.payload.workKey==='image-work'?'a'.repeat(64):'b'.repeat(64)}] };
        if (request.command === 'wallpaper.status') result = { activeJob:null, capabilities:{mediaApply:true,previewMedia:false} };
        if (result) queueMicrotask(() => window.hertzWallpaperSettings.applyManagement({ protocol: 2, requestId: request.requestId, ok: true, configRevision: window.nativeTestRevision, jobId: null, result, error: null }));
      } };
    });
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
    assert.equal((await page.evaluate(() => window.desktopRequests)).some(request => request.command === 'wallpaper.apply' || request.cmd === 'lyrics-apply'), false, 'style preview must not submit changes');
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), initial);
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42', 'polling must preserve dirty input');
    await page.locator('#bg-light').click();
    assert.equal(await page.locator('#lyrics-preview.light').count(), 1);
    await page.locator('#apply').click();
    await page.waitForFunction(() => window.desktopRequests.some(request => request.command === 'wallpaper.apply'));
    const apply = await page.evaluate(() => window.desktopRequests.filter(request => request.command === 'wallpaper.apply').at(-1));
    const update = await page.evaluate(() => window.desktopRequests.filter(request => request.command === 'wallpaper.draft.update').at(-1));
    assert.equal(apply.expectedRevision, 9); assert.equal(apply.payload.draftRevision, 2);
    assert.equal(update.payload.operations[1].lyrics.fontSize, 42); assert.equal(update.payload.operations[1].lyrics.secondary, 'translation'); assert.deepEqual(update.payload.operations[0].wallpaper, initial.config);
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), { ...initial, message: '已应用' });
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42', 'a status message cannot consume the in-flight draft');
    assert.equal(await page.locator('#lyrics-size').isEnabled(), false, 'only the matching apply receipt unlocks editing');
    await page.evaluate(requestId => window.hertzWallpaperSettings.applyManagement({ protocol: 2, requestId, ok: false, error: { code: 'config_write_failed', message: '保存失败' } }), apply.requestId);
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    await page.evaluate(payload => window.hertzWallpaperSettings.applyStatus(payload), { ...initial, error: '保存失败' });
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42');
    assert.equal(await page.locator('#apply').isEnabled(), true);
    const external = structuredClone(initial); external.revision = 10; external.lyricsConfig.fontSize = 35;
    await page.evaluate(payload => { window.nativeTestRevision = payload.revision; window.hertzWallpaperSettings.applyStatus(payload); }, external);
    assert.equal(await page.locator('#conflict').isVisible(), true);
    assert.equal(await page.locator('#apply').isEnabled(), false);
    assert.equal(await page.locator('#lyrics-size').inputValue(), '42');
    await page.locator('#discard').click();
    assert.equal(await page.locator('#lyrics-size').inputValue(), '35');
    assert.equal(await page.locator('#conflict').isVisible(), false);
    // Editing an incomplete number also survives status refreshes.
    await page.locator('#lyrics-size').fill('');
    await page.evaluate(payload => { window.nativeTestRevision = payload.revision; window.hertzWallpaperSettings.applyStatus(payload); }, external);
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
    await page.evaluate(payload => { window.nativeTestRevision = payload.revision; window.hertzWallpaperSettings.applyStatus(payload); }, external);
    await page.locator('#tab-wallpaper').click();
    await page.locator('[data-scene=coast]').click();
    assert.equal(await page.locator('#scene-source').inputValue(), 'fixed');
    assert.equal(await page.locator('#scene-fixed').inputValue(), 'coast');
    await page.locator('#preview').click();
    await page.waitForFunction(() => window.desktopRequests.some(request => request.command === 'wallpaper.preview.acquire'));
    const preview = await page.evaluate(() => window.desktopRequests.filter(request => request.command === 'wallpaper.preview.acquire').at(-1));
    assert.equal(preview.payload.draftId, 'browser-draft');
    const previewUpdate = await page.evaluate(() => window.desktopRequests.filter(request => request.command === 'wallpaper.draft.update').at(-1));
    assert.equal(previewUpdate.payload.operations[0].wallpaper.groups[0].selection.sceneId, 'coast');
    await page.evaluate(payload => { window.hertzWallpaperSettings.applyStatus(payload); window.hertzWallpaperSettings.mountPreview('browser-lease'); }, { ...external, previewActive: true, previewLease: 'browser-lease' });
    await page.waitForFunction(() => window.desktopRequests.some(request => request.cmd === 'preview-event' && request.event === 'wallpaper_dom_ready'));
    // This is the same renderer/config/start bridge used by the native preview lease.
    await page.evaluate(() => window.hertzWallpaperSettings.evalPreview("window.hertzWallpaper.applyConfig({source:'fixed',scene:'coast',musicResponse:true}); window.hertzWallpaper.start(15);"));
    await page.waitForFunction(() => document.querySelector('#preview-renderer').contentDocument.querySelector('canvas'));
    await page.waitForTimeout(500);
    const out = path.join(root, 'output/playwright/desktop-settings'); fs.mkdirSync(out, { recursive: true });
    await page.evaluate(() => document.querySelector('main').scrollTop = 0);
    await page.screenshot({ path: path.join(out, 'wallpaper-1120.png') });
    await page.locator('#tab-lyrics').click();
    await page.waitForFunction(() => window.desktopRequests.some(request => request.command === 'wallpaper.preview.release'));
    assert.equal((await page.evaluate(() => window.desktopRequests.filter(request => request.command === 'wallpaper.preview.release').at(-1))).payload.leaseId, 'browser-lease');
    await page.evaluate(() => window.hertzWallpaperSettings.unmountPreview());
    assert.equal(await page.locator('#preview-renderer').count(), 0);
    await page.screenshot({ path: path.join(out, 'lyrics-1120.png') });
    const missing = structuredClone(external); missing.config.groups[0].displays = [{ kind: 'unresolved', legacyName: 'DISPLAY9' }]; missing.runtime.wallpaper = { enabled: true, monitorMissing: true };
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
    // Local versions use the same draft and Apply lifecycle as builtin scenes.
    await page.evaluate(payload => { window.nativeTestRevision=payload.revision; hertzWallpaperSettings.applyStatus(payload); }, external);
    await page.setViewportSize({width:1120,height:700});
    await page.locator('#tab-wallpaper').click();await page.locator('#local-library > summary').click();
    const imageWork=page.locator('#library-works > li').filter({has:page.getByText('图片 <img src=x onerror=alert(1)>',{exact:true})});
    const videoWork=page.locator('#library-works > li').filter({has:page.getByText('本地视频',{exact:true})});
    await imageWork.getByRole('button',{name:'查看版本',exact:true}).click();
    await videoWork.getByRole('button',{name:'查看版本',exact:true}).click();
    assert.equal(await page.locator('#library-works img').count(),0,'untrusted titles stay text');
    const applyCount=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.apply').length);
    await imageWork.getByRole('button',{name:'选择此版本',exact:true}).click();
    assert.equal(await page.locator('#scene-heading').innerText(),'图片 <img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#scene-source').inputValue(),'library');
    assert.equal(await page.locator('#scene-fixed').locator('..').isVisible(),false);
    assert.equal(await page.locator('#scene-static').isVisible(),false);
    assert.match(await page.locator('#preview-placeholder-text').innerText(),/媒体实时预览尚未提供/);
    for(const id of ['fps','quality','music','motion','preview'])assert.equal(await page.locator('#'+id).isDisabled(),true,id+' is honest for static media');
    assert.equal(await page.locator('#media-fit').isEnabled(),true);await page.locator('#media-fit').selectOption('contain');
    await page.evaluate(payload=>hertzWallpaperSettings.applyStatus(payload),{...external,mediaPreviewAvailable:true});
    assert.equal(await page.locator('#preview').isEnabled(),true,'native media capability enables explicit preview');
    const previewCount=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.preview.acquire').length);
    await page.locator('#preview').click();
    await page.waitForFunction(count=>desktopRequests.filter(request=>request.command==='wallpaper.preview.acquire').length>count,previewCount);
    const previewDraft=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.draft.update').at(-1));
    assert.equal(previewDraft.payload.operations[0].wallpaper.groups[0].selection.workKey,'image-work');
    await page.evaluate(payload=>hertzWallpaperSettings.applyStatus(payload),{...external,mediaPreviewAvailable:true,previewActive:true,previewLease:'browser-lease',mediaPreview:{kind:'media',firstFrameReady:true}});
    assert.equal(await page.locator('#preview-renderer').count(),0,'native media preview never creates an iframe decoder');
    assert.equal(await page.locator('#preview-placeholder').isVisible(),true);assert.match(await page.locator('#preview-placeholder-title').innerText(),/独立预览窗口/);
    await page.locator('#tab-lyrics').click();
    await page.waitForFunction(()=>desktopRequests.filter(request=>request.command==='wallpaper.preview.release').length>=2);
    await page.evaluate(payload=>hertzWallpaperSettings.applyStatus(payload),{...external,mediaPreviewAvailable:true,previewActive:false});
    await page.locator('#tab-wallpaper').click();
    assert.equal(await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.apply').length),applyCount,'version choice never applies automatically');
    await page.locator('#discard').click();assert.equal(await page.locator('#media-fit-field').isVisible(),false);assert.equal(await page.locator('#preview').isEnabled(),true);
    await videoWork.getByRole('button',{name:'选择此版本',exact:true}).click();
    assert.equal(await page.locator('#motion').isEnabled(),true);assert.match(await page.locator('#media-rate-note').innerText(),/原速静音/);
    await page.locator('#media-fit').selectOption('stretch');
    await page.locator('#apply').click();
    await page.waitForFunction(count=>desktopRequests.filter(request=>request.command==='wallpaper.apply').length>count,applyCount);
    const mediaApply=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.apply').at(-1));
    const mediaUpdate=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.draft.update').at(-1));
    const mediaDraft=mediaUpdate.payload.operations[0].wallpaper;
    assert.deepEqual(mediaDraft.groups[0].selection,{kind:'package',workKey:'video-work',packageHash:'b'.repeat(64)});
    assert.equal(mediaDraft.groups[0].presentation.fit,'stretch');assert.deepEqual(mediaDraft.audioInput,{kind:'none'});
    for(const button of await page.locator('[data-library-select]').all())assert.equal(await button.isDisabled(),true,'pending Apply locks every version choice');
    assert.equal(await page.evaluate(()=>hertzWallpaperSettings.chooseLibraryVersion(nativeLibraryWorks[0],{state:'installed',packageHash:'a'.repeat(64),version:3})),false,'the draft guard also rejects programmatic changes during Apply');
    await page.locator('#library-refresh').click();await imageWork.getByRole('button',{name:'查看版本',exact:true}).click();
    assert.equal(await imageWork.locator('[data-library-select]').isDisabled(),true,'versions loaded during Apply remain locked');
    await page.evaluate(requestId=>hertzWallpaperSettings.applyManagement({protocol:2,requestId,ok:false,error:{code:'prepare_failed',message:'准备失败，保留草稿'}}),mediaApply.requestId);
    await page.waitForFunction(()=>!document.getElementById('apply').disabled);
    assert.equal(await page.locator('#scene-heading').innerText(),'本地视频','failed Apply preserves media draft');
    await page.screenshot({path:path.join(out,'local-video-1120.png')});
    await page.locator('#discard').click();assert.equal(await page.locator('#media-fit-field').isVisible(),false);
    const endpointName = '扬声器 <img src=x onerror=alert(1)>';
    const audioStatus = { ...external, runtime: { ...external.runtime, wallpaper: { ...external.runtime.wallpaper, audio: { phase:'idle', captureActive:false, requested:null, endpoints:[{id:'render-a',name:endpointName,isDefault:true}] } } } };
    await page.evaluate(payload=>hertzWallpaperSettings.applyStatus(payload), audioStatus);
    await page.locator('#music').selectOption('system');
    assert.equal(await page.locator('#audio-device-field').isVisible(),true);
    assert.equal(await page.locator('#audio-device option[value="render-a"]').textContent(),endpointName+' · 默认');
    assert.equal(await page.locator('#audio-device img').count(),0,'endpoint names are text');
    await page.locator('#audio-device').selectOption('render-a');
    await page.locator('#audio-options summary').click();
    for (const [id,value] of [['audio-gain','2'],['audio-attack','75'],['audio-release','300']]) {
      await page.locator('#'+id).fill(value); await page.locator('#'+id).dispatchEvent('change');
    }
    await page.locator('#audio-gain').fill('5'); await page.locator('#audio-gain').dispatchEvent('change');
    assert.equal(await page.locator('#apply').isDisabled(),true,'invalid audio gain blocks Apply');
    await page.locator('#audio-gain').fill('2'); await page.locator('#audio-gain').dispatchEvent('change');
    const audioPreviewCount=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.preview.acquire').length);
    await page.locator('#preview').click();
    await page.waitForFunction(count=>desktopRequests.filter(request=>request.command==='wallpaper.preview.acquire').length>count,audioPreviewCount);
    const audioUpdate=await page.evaluate(()=>desktopRequests.filter(request=>request.command==='wallpaper.draft.update').at(-1));
    const audioInput={kind:'system',device:{kind:'fixed',id:'render-a'},gain:2,attackMs:75,releaseMs:300};
    assert.deepEqual(audioUpdate.payload.operations[0].wallpaper.audioInput,audioInput);
    await page.locator('#discard').click();
    const fixedMissing={...audioStatus, message:'已应用', config:{...audioStatus.config,audioInput}, runtime:{...audioStatus.runtime,wallpaper:{...audioStatus.runtime.wallpaper,audio:{phase:'failed',requested:audioInput.device,captureActive:false,error:'指定设备已断开',endpoints:[]}}}};
    await page.evaluate(payload=>hertzWallpaperSettings.applyStatus(payload),fixedMissing);
    assert.equal(await page.locator('#audio-device').inputValue(),'render-a','missing fixed endpoint is preserved');
    assert.match(await page.locator('#audio-device').innerText(),/当前不可用/);
    assert.match(await page.locator('#audio-state').innerText(),/指定设备已断开/);
    await page.locator('#audio-retry').click();
    assert.equal((await page.evaluate(()=>desktopRequests.at(-1))).cmd,'audio-retry');
    await page.screenshot({path:path.join(out,'system-audio-1120.png')});
    await page.locator('#music').selectOption('none');
    assert.equal(await page.locator('#audio-device-field').isVisible(),false);
    assert.equal(await page.locator('#audio-gain').isDisabled(),true);
    assert.deepEqual(errors, []);
    console.log('desktop settings browser checks passed: draft/apply/discard, dirty close guard, presets, static thumbnails, conflict, real renderer, leases, position, monitor recovery, responsive layout, local media version selection, pending guard, system audio drafts, missing devices and retry');
    console.log('screenshots: ' + out);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
