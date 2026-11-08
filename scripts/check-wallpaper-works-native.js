// SPDX-License-Identifier: MIT
// Real, isolated settings UI: persistent work CAS, native preview and builtin packages.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const nativeRequest = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const binary = process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe');
const output = path.join(root, 'output/playwright/wallpaper-works-native-' + Date.now());
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let child, browser, settings, launches = 0, seq = 0;
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(label);
}
async function start() {
  const port = Number(process.env.DESKTOP_CDP_PORT || 19548) + launches++;
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } });
  await until(async () => { if (child.exitCode !== null) throw new Error('owned desktop exited ' + child.exitCode); try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'native settings startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  settings = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/settings.html')), 'settings page');
  settings.on('pageerror', error => errors.push(error.message));
  await settings.waitForSelector('#enabled:enabled');
  await settings.evaluate(() => {
    const original = hertzWallpaperSettings.requestManagement;
    window.__workRequestSizes = [];
    hertzWallpaperSettings.requestManagement = function (command, payload, ...rest) {
      window.__workRequestSizes.push(new TextEncoder().encode(JSON.stringify({ protocol: 2, requestId: 'bounded-request-id-' + 'x'.repeat(64), command, payload })).length);
      return original.call(this, command, payload, ...rest);
    };
  });
}
async function stop() {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process exit', 5000); }
  browser = settings = child = null;
}
async function api(command, payload = {}, expectedRevision) {
  return settings.evaluate(async ({ command, payload, expectedRevision, id }) => {
    try { return await hertzWallpaperSettings.requestManagement(command, payload, id, expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, { command, payload, expectedRevision, id: 'works-native-' + (++seq) });
}
async function native(command) {
  for (let attempt=0;;attempt++) {
    try { return await nativeRequest(pipe, command); }
    catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code) || attempt>=20) throw error; await delay(50); }
  }
}
const status = () => native({ command: 'status' });
const configFile = path.join(output, 'config.json');
function reference(draft) { return { draftId: draft.draftId, draftRevision: draft.draftRevision }; }
async function main() {
  // Do not attach to or stop an already-running user desktop.
  try { await nativeRequest(pipe, { command: 'status' }); throw new Error('A desktop host is already running; close it before this isolated native check.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  fs.mkdirSync(output, { recursive: true });
  try {
    await start();
    await settings.locator('#scene-source').selectOption('fixed');
    await settings.locator('#scene-fixed').selectOption('coast');
    await settings.locator('#work-editor > summary').click();
    await settings.locator('#work-new').click();
    await settings.locator('#work-fields').waitFor({ state: 'visible' });
    await until(async () => /作品已保存/.test(await settings.locator('#work-message').textContent()), 'save new work');
    const baseline = fs.existsSync(configFile) ? hash(fs.readFileSync(configFile)) : null;
    await settings.locator('#work-title').fill('场景作品 · 原生往返');
    await settings.locator('[data-work-param="tod"]').fill('0.25');
    await settings.locator('[data-work-public="tod"]').check();
    await settings.locator('[data-work-public-label="tod"]').fill('一天中的时段');
    await settings.locator('[data-work-public="discRing"]').check();
    await until(async () => /作品已保存/.test(await settings.locator('#work-message').textContent()), 'debounced work save');
    let list = await api('wallpaper.draft.list'); assert.equal(list.ok, true, JSON.stringify(list));
    const draftId = list.result.drafts[0].draftId;
    let draft = (await api('wallpaper.draft.get', { draftId })).result;
    assert.equal(draft.title, '场景作品 · 原生往返'); assert.equal(draft.savedRevision, draft.draftRevision);
    assert.equal(draft.propertyCount, 2);
    const properties = (await api('wallpaper.draft.properties', { ...reference(draft), limit: 1 })).result;
    assert.equal(properties.properties[0].id, 'disc-ring');
    assert.equal(properties.properties[0].target.property, 'discRing');
    const nextProperties = (await api('wallpaper.draft.properties', { ...reference(draft), limit: 1, cursor: properties.nextCursor })).result;
    assert.equal(nextProperties.properties[0].default, 0.25);
    assert.equal(nextProperties.properties[0].label, '一天中的时段');
    assert.equal(nextProperties.nextCursor, null);
    assert.equal((await api('wallpaper.draft.properties', { draftId, draftRevision: 1, limit: 1 })).error.code, 'draft_conflict');
    assert.equal(baseline, fs.existsSync(configFile) ? hash(fs.readFileSync(configFile)) : null);
    const conflict = await api('wallpaper.draft.update', { draftId, draftRevision: 1, operations: [{ kind: 'replaceMetadata', title: 'stale', description: '' }] });
    assert.equal(conflict.error.code, 'draft_conflict');
    checks.push('typed editor autosaves with independent CAS and leaves desktop configuration unchanged');
    checks.push('public property exposure uses kebab IDs and exact registry targets, persists labels/defaults and pages by revision');
    const other = (await api('wallpaper.draft.create', { kind: 'work', document: { title: '切换保护目标', sceneId: 'coast', stateVersion: 1, params: {} } })).result;
    await settings.locator('#work-refresh').click();
    await until(async () => await settings.locator('#work-draft-select option').count() === 2 && await settings.locator('#work-open').isEnabled(), 'refresh two drafts');
    for (const command of ['wallpaper.draft.get', 'wallpaper.draft.parameters', 'wallpaper.draft.properties', 'wallpaper.draft.schema']) {
      const editedTitle = '切换前已保存 · ' + command;
      await settings.locator('#work-title').fill(editedTitle);
      await settings.locator('#work-draft-select').selectOption(other.draftId);
      await settings.evaluate(command => {
        const original = hertzWallpaperSettings.requestManagement;
        const gate = window.__workReadGate = { waiting: false, consumed: false, original };
        hertzWallpaperSettings.requestManagement = async function (...args) {
          const receipt = await original.apply(this, args);
          if (args[0] === command && !gate.consumed) {
            gate.consumed = true;
            return new Promise(resolve => { gate.release = () => resolve(receipt); gate.waiting = true; });
          }
          return receipt;
        };
      }, command);
      await settings.locator('#work-open').click();
      await settings.waitForFunction(() => window.__workReadGate.waiting);
      assert.equal(await settings.locator('#work-title').isDisabled(), true, command + ' locks the previous title');
      assert.equal(await settings.locator('[data-work-param="tod"]').isDisabled(), true, command + ' locks the previous parameters');
      assert.equal(await settings.locator('[data-work-public="tod"]').isDisabled(), true, command + ' locks public property edits');
      assert.equal(await settings.locator('#work-open').isDisabled(), true, command + ' locks navigation');
      const savedBeforeSwitch = (await api('wallpaper.draft.get', { draftId })).result;
      assert.equal(savedBeforeSwitch.title, editedTitle);
      assert.equal(savedBeforeSwitch.savedRevision, savedBeforeSwitch.draftRevision);
      await settings.evaluate(() => { const gate = window.__workReadGate; hertzWallpaperSettings.requestManagement = gate.original; gate.release(); delete window.__workReadGate; });
      await until(async () => await settings.locator('#work-title').isEnabled() && await settings.locator('#work-title').inputValue() === '切换保护目标', 'unlock after ' + command);
      await settings.locator('#work-draft-select').selectOption(draftId);
      await settings.locator('#work-open').click();
      await until(async () => await settings.locator('#work-title').isEnabled() && await settings.locator('#work-title').inputValue() === editedTitle, 'restore edited first draft');
    }
    await settings.locator('#work-title').fill('场景作品 · 原生往返');
    await settings.locator('#work-save').click();
    await until(async () => /作品已保存/.test(await settings.locator('#work-message').textContent()), 'restore first title');
    await api('wallpaper.draft.discard', reference(other));
    checks.push('draft switching saves prior input and locks editing and navigation during delayed native get, parameters, properties and schema receipts');
    await settings.locator('#work-preview').click();
    await until(async () => (await status()).wallpaper.mediaPreview?.firstFrameReady, 'work native preview first frame');
    await settings.locator('#preview').click();
    await until(async () => !(await status()).wallpaper.mediaPreview, 'shared preview release');
    await settings.locator('#work-preview').click();
    await until(async () => (await status()).wallpaper.mediaPreview?.firstFrameReady, 'work native preview reacquire');
    await settings.locator('#preview').click();
    checks.push('work preview uses the shared native lease and can reopen after main settings release');
    await settings.locator('#work-publish').click();
    await until(async () => /已生成版本 1/.test(await settings.locator('#work-message').textContent()), 'publish immutable builtin version');
    draft = (await api('wallpaper.draft.get', { draftId })).result;
    const packageFile = path.join(output, 'packages', draft.packageHash, 'original.hwpkg');
    assert.equal(hash(fs.readFileSync(packageFile)), draft.packageHash);
    const published = await api('wallpaper.draft.publish', reference(draft)); assert.equal(published.result.packageHash, draft.packageHash);
    const authored = (await api('wallpaper.draft.create', { kind: 'work', workKey: draft.workKey, packageHash: draft.packageHash })).result;
    const authoredProperties = (await api('wallpaper.draft.properties', reference(authored))).result.properties;
    assert.equal(authoredProperties.find(property => property.id === 'tod').default, 0.25);
    assert.equal(authoredProperties.find(property => property.id === 'disc-ring').target.property, 'discRing');
    await api('wallpaper.draft.discard', reference(authored));
    checks.push('committed work publishes a byte-addressed package and repeat publish is idempotent');
    await stop(); await start();
    list = await api('wallpaper.draft.list'); assert.equal(list.result.drafts[0].draftId, draftId);
    await settings.locator('#work-editor > summary').click();
    await settings.locator('#work-open').click();
    await until(async () => await settings.locator('#work-title').inputValue() === '场景作品 · 原生往返', 'reopen work after restart');
    assert.equal(await settings.locator('[data-work-param="tod"]').inputValue(), '0.25');
    assert.equal(await settings.locator('[data-work-public="tod"]').isChecked(), true);
    assert.equal(await settings.locator('[data-work-public-label="tod"]').inputValue(), '一天中的时段');
    assert.equal(await settings.locator('[data-work-public="discRing"]').isChecked(), true);
    checks.push('work metadata, scene parameters and public properties survive publication, authored reopen and a real host restart');
    await settings.locator('#local-library > summary').click();
    let row = settings.locator('#library-works > li').filter({ has: settings.getByText('场景作品 · 原生往返', { exact: true }) });
    await row.getByRole('button', { name: '查看版本', exact: true }).click();
    await row.getByRole('button', { name: '选择此版本', exact: true }).click();
    await settings.locator('#enabled').check();
    assert.equal(await settings.locator('#music').isEnabled(), true);
    assert.equal(await settings.locator('#quality').isEnabled(), true);
    await settings.locator('#apply').click();
    await until(async () => { const s = await status(); return s.wallpaper?.firstFrameReady && s.wallpaper?.runtimeBuiltin?.sceneId === 'coast'; }, 'builtin package desktop first frame', 45000);
    const runtime = await status();
    assert.equal(runtime.wallpaper.runtimeBuiltin.params.tod, 0.25);
    assert.ok(runtime.wallpaper.glAllocation || runtime.wallpaper.budget?.glContexts > 0, 'builtin package reserves GL budget');
    checks.push('fixed builtin package applies with its saved parameters, real first frame and GL admission');
    await settings.locator('[data-property-input="tod"]').waitFor({ state: 'visible' });
    const beforeOverride = fs.readFileSync(configFile, 'utf8');
    await settings.locator('[data-property-input="tod"]').fill('0.4');
    await settings.locator('[data-property-input="tod"]').dispatchEvent('change');
    await settings.locator('#preview').click();
    await until(async () => (await status()).wallpaper.mediaPreview?.firstFrameReady, 'public property preview');
    assert.equal((await status()).wallpaper.mediaPreview.runtimeBuiltin.params.tod, 0.4);
    assert.equal(fs.readFileSync(configFile, 'utf8'), beforeOverride);
    assert.equal((await status()).wallpaper.runtimeBuiltin.params.tod, 0.25);
    await settings.locator('#preview').click();
    await settings.locator('#apply').click();
    await until(async () => { const state = (await status()).wallpaper; return state.firstFrameReady && !state.handoff && state.runtimeBuiltin?.params.tod === 0.4; }, 'group public override applies');
    assert.equal(hash(fs.readFileSync(packageFile)), draft.packageHash);
    await stop(); await start();
    await until(async () => { const state = (await status()).wallpaper; return state.firstFrameReady && state.runtimeBuiltin?.params.tod === 0.4; }, 'public override restart');
    await settings.locator('[data-property-reset="tod"]').click();
    await settings.locator('#apply').click();
    await until(async () => { const state = (await status()).wallpaper; return state.firstFrameReady && !state.handoff && state.runtimeBuiltin?.params.tod === 0.25; }, 'property reset restores package default');
    checks.push('public override previews independently, applies, survives native restart, resets to package default and preserves immutable package bytes');
    row = settings.locator('#library-works > li').filter({ has: settings.getByText('场景作品 · 原生往返', { exact: true }) });
    await settings.locator('#local-library > summary').click();
    await row.getByRole('button', { name: '查看版本', exact: true }).click();
    const publicTime = { ...nextProperties.properties[0], default: 0.65 };
    const modified = await api('wallpaper.draft.update', Object.assign(reference(draft), { operations: [{ kind: 'setParam', id: 'tod', value: 0.65 }, { kind: 'setProperty', property: publicTime }] }));
    assert.equal(modified.ok, true, JSON.stringify(modified));
    draft = (await api('wallpaper.draft.save', reference(modified.result))).result;
    const second = (await api('wallpaper.draft.publish', reference(draft))).result;
    await settings.locator('#library-refresh').click();
    await until(async () => await row.getByRole('button', { name: '查看版本', exact: true }).count(), 'refreshed work row');
    await row.getByRole('button', { name: '查看版本', exact: true }).click();
    const versions = row.locator('.library-version');
    await versions.filter({ hasText: '版本 1 ·' }).getByRole('button', { name: '加入轮播' }).click();
    await versions.filter({ hasText: '版本 2 ·' }).getByRole('button', { name: '加入轮播' }).click();
    await settings.locator('#playlist-title').fill('昼夜轮播');
    await settings.locator('#playlist-interval').fill('10');
    await settings.locator('#playlist-save').click();
    await until(async () => /轮播列表已保存/.test(await settings.locator('#playlist-message').textContent()), 'save playlist from fixed version buttons');
    await settings.locator('#playlist-choose').click();
    await until(async () => /已为原显示组选择此轮播列表/.test(await settings.locator('#playlist-message').textContent()), 'select playlist settings draft');
    await settings.locator('#apply').click();
    await until(async () => { const s = (await status()).wallpaper; return s.playlist?.currentIndex === 0 && !s.handoff; }, 'playlist first item reveal', 45000);
    const configAtPlaylist = hash(fs.readFileSync(configFile));
    const playlistId = (await status()).wallpaper.playlist.playlistId;
    await until(async () => { const s = (await status()).wallpaper; return s.playlist?.currentIndex === 1 && !s.handoff; }, 'automatic renderable-time next item', 25000);
    assert.equal(hash(fs.readFileSync(configFile)), configAtPlaylist, 'rotation never writes desktop config revision');
    assert.equal((await status()).wallpaper.runtimeBuiltin.params.tod, 0.65);
    checks.push('playlist UI saves fixed versions and automatic sequential rotation keeps configuration revision unchanged');
    await native({ command: 'wallpaper-hide' });
    await until(async () => !(await status()).wallpaper.visible, 'manual pause');
    for (let tick=0; tick<12; tick++) { await delay(1000); assert.equal((await status()).wallpaper.playlist.currentIndex, 1); }
    await native({ command: 'wallpaper-show' });
    await delay(2500); assert.equal((await status()).wallpaper.playlist.currentIndex, 1, 'no catch-up after pause');
    await until(async () => { const s=(await status()).wallpaper;return s.playlist.currentIndex===0 && !s.handoff; }, 'resume counts a full remaining interval', 20000);
    checks.push('native pause freezes the rotation clock and resume does not catch up');
    const secondFile = path.join(output, 'packages', second.packageHash, 'original.hwpkg');
    const held = secondFile + '.test-backup';
    fs.renameSync(secondFile, held);
    try {
      assert.equal((await api('wallpaper.playlist.next', { playlistId })).ok, true);
      await until(async () => (await status()).wallpaper.playlist.failed, 'failed next item stops rotation');
      assert.equal((await api('wallpaper.playlist.next', { playlistId })).error.code, 'playlist_failed');
      for (let tick=0; tick<11; tick++) { await delay(1000); assert.equal((await status()).wallpaper.playlist.currentIndex, 0); }
    } finally { fs.renameSync(held, secondFile); }
    assert.equal((await api('wallpaper.playlist.next', { playlistId, retry: true })).ok, true);
    await until(async () => { const s=(await status()).wallpaper;return s.playlist.currentIndex===1 && !s.playlist.failed && !s.handoff; }, 'explicit retry same failed version', 45000);
    assert.equal(hash(fs.readFileSync(configFile)), configAtPlaylist);
    checks.push('missing next package stops iteration, retains previous item, and explicit retry recovers the same version');
    await stop(); await start();
    await until(async () => { const s=(await status()).wallpaper;return s.playlist?.currentIndex===0 && !s.handoff; }, 'saved playlist cold start', 45000);
    assert.equal((await status()).wallpaper.playlist.playlistId, playlistId);
    checks.push('saved playlist restores after host restart through the same native preparation and handoff owner');
    const inspected = await api('wallpaper.properties.inspect', { selection: { kind: 'playlist', playlistId }, limit: 1 });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.deepEqual(inspected.result.properties.map(property => property.id), ['disc-ring']);
    const overriddenRing = !inspected.result.properties[0].default;
    await settings.locator('[data-property-input="disc-ring"]').setChecked(overriddenRing);
    await settings.locator('#apply').click();
    await until(async () => { const state = (await status()).wallpaper; return state.firstFrameReady && !state.handoff && state.runtimeBuiltin?.params.discRing === overriddenRing; }, 'playlist shared public override');
    const listBefore = (await api('wallpaper.playlist.get', { playlistId })).result;
    const incompatibleWork = (await api('wallpaper.draft.create', { kind: 'work', document: { title: '不共享公开属性', sceneId: 'coast', stateVersion: 1, params: {} } })).result;
    const incompatibleSaved = (await api('wallpaper.draft.save', reference(incompatibleWork))).result;
    const incompatible = (await api('wallpaper.draft.publish', reference(incompatibleSaved))).result;
    const incompatibleEdit = await api('wallpaper.playlist.save', { playlistId, expectedPlaylistRevision: listBefore.revision, title: listBefore.title,
      mode: listBefore.mode, intervalSeconds: listBefore.intervalSeconds, items: [listBefore.items[0], { workKey: incompatible.workKey, packageHash: incompatible.packageHash }] });
    assert.equal(incompatibleEdit.ok, false); assert.equal(incompatibleEdit.error.code, 'invalid_property_value');
    assert.deepEqual((await api('wallpaper.playlist.get', { playlistId })).result, listBefore);
    const readConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const configured = (readConfig.activeProfile ? readConfig.profiles.find(domain => JSON.stringify(domain.profile) === JSON.stringify(readConfig.activeProfile)) : readConfig.unboundDomain).wallpaper;
    const badDraft = (await api('wallpaper.draft.create', { kind: 'settings' })).result;
    const badWallpaper = structuredClone(configured); badWallpaper.enabled = false;
    badWallpaper.groups[0].displays = [{ kind: 'fixed', displayId: 'public-properties-offline-' + Date.now() }];
    badWallpaper.groups[0].selection = { kind: 'package', workKey: incompatible.workKey, packageHash: incompatible.packageHash };
    const badUpdated = await api('wallpaper.draft.update', { ...reference(badDraft), operations: [{ kind: 'replaceWallpaper', wallpaper: badWallpaper }] });
    assert.equal(badUpdated.ok, true, JSON.stringify(badUpdated));
    const rejected = await api('wallpaper.apply', reference(badUpdated.result), badDraft.baseRevision);
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid_property_value');
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).revision, readConfig.revision);
    await api('wallpaper.draft.discard', reference(badUpdated.result));
    checks.push('whole-playlist shared override rejects incompatible list edits and new disabled offline property intent before commit');
    await require('./wallpaper-reference-checks')({ api, native, settings, output, checks, until });
    await settings.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    assert.equal(await settings.evaluate(() => Math.max(...window.__workRequestSizes) < 16 * 1024), true, 'request envelope remains within 16 KiB');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ binarySha256: hash(fs.readFileSync(binary)), checks, errors }, null, 2));
    console.log(JSON.stringify({ output, checks }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    try { fs.writeFileSync(path.join(output, 'failure-status.json'), JSON.stringify(await status(), null, 2)); } catch {}
    if (settings && !settings.isClosed()) await settings.screenshot({ path: path.join(output, 'failure-settings.png'), timeout: 5000 }).catch(() => {});
    throw error;
  } finally { await stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
