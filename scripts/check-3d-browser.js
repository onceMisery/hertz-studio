'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const web = path.join(root, 'crates', 'vmusicd', 'web');
const output = path.join(root, 'output', 'playwright', '3d');
const base = process.env.STAGE3D_UI_URL || 'http://127.0.0.1:18774';
const localAssets = process.env.STAGE3D_LOCAL_ASSETS === '1';
const allowStale = process.env.STAGE3D_ALLOW_STALE === '1';
const staleAssets = [];
const assets = ['stage3d.js', 'stage3d.css', 'stage-shelf.js', 'stage-freecam.js', 'shelf.js', 'lyric3d.js'];
const normalize = text => text.replace(/\r\n/g, '\n').trim();

async function main() {
  if (!localAssets) {
    for (const file of assets) {
      const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok, 'Cannot fetch ' + file);
      if (normalize(await response.text()) !== normalize(fs.readFileSync(path.join(web, file), 'utf8'))) {
        staleAssets.push(file);
        const message = 'Stale embedded asset: ' + file + '. Rebuild the service, or explicitly set STAGE3D_LOCAL_ASSETS=1.';
        assert.ok(allowStale, message);
        console.warn(message + ' Running mismatched embedded assets for diagnosis.');
      }
    }
  }
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: process.env.STAGE3D_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const errors = [];
  const checks = [];
  const pass = label => { checks.push(label); console.log('PASS ' + label); };
  page.on('pageerror', error => errors.push(error.message));
  try {
    if (localAssets) {
      for (const file of assets) {
        await page.route('**/' + file, route => route.fulfill({
          contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript',
          body: fs.readFileSync(path.join(web, file), 'utf8')
        }));
      }
    }
    await page.route('**/v1/**', route => {
      if (['GET', 'HEAD'].includes(route.request().method())) return route.continue();
      return route.fulfill({ status: 200, json: {} });
    });
    await page.goto(base);
    await page.waitForFunction(() => window.Stage3D && window.Stage && document.getElementById('conn').textContent === '服务已连接');
    await page.evaluate(() => {
      const original = Stage.presentation.bind(Stage);
      window.__stage3dCheck = { id: 'browser-fixture-a', position: 12000, duration: 180000, commands: [] };
      Stage.presentation = function () {
        const fixture = window.__stage3dCheck;
        return { ...original(), track: { id: fixture.id, title: '3D browser fixture', artist: 'Interaction check' },
          position: fixture.position, duration: fixture.duration, playing: false, cover: null };
      };
      document.addEventListener('stage:control', event => {
        event.stopImmediatePropagation();
        window.__stage3dCheck.commands.push(event.detail);
      }, true);
      Stage3D.configure({ motion: 0, cruise: false, shelfMode: 'off', foliaVisual: 'stage', foliaBg: 'stage', lyrics: false });
      Stage3D.open('orb');
    });
    const seek = page.locator('#s3d-seek');
    await page.waitForFunction(() => !document.getElementById('s3d-seek').disabled);
    await page.waitForFunction(() => Stage3D.stats().buffer !== '0x0');
    const baseline = await page.evaluate(() => Stage3D.stats());
    assert.ok(baseline.dpr > 0, 'WebGL rendering is required for this browser check');
    pass('3D stage opens with WebGL');

    async function beginDrag() {
      await page.mouse.move(700, 500);
      await seek.focus();
      const box = await seek.boundingBox();
      assert.ok(box && box.width > 10, 'Seek must be visible');
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 });
      assert.ok(Number(await seek.inputValue()) > 60000, 'Native drag must enter preview');
    }
    async function expectRecovered(label) {
      await page.mouse.up();
      await page.evaluate(() => { window.__stage3dCheck.position += 1000; });
      await page.waitForFunction(() => Number(document.getElementById('s3d-seek').value) === window.__stage3dCheck.position);
      assert.equal(await page.evaluate(() => window.__stage3dCheck.commands.filter(command => command.action === 'seek').length), 0, 'Cancelled drag must not submit seek');
      pass(label);
    }
    await beginDrag();
    await seek.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await expectRecovered('native seek drag + injected pointercancel restores live progress');
    await beginDrag();
    await seek.evaluate(element => element.blur());
    await expectRecovered('seek element blur restores live progress');
    await beginDrag();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expectRecovered('window blur event cancels seek');
    await beginDrag();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.mouse.up();
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectRecovered('injected visibility lifecycle restores seek');
    await beginDrag();
    await page.evaluate(() => { window.__stage3dCheck.id = 'browser-fixture-b'; window.__stage3dCheck.position = 3000; });
    await page.waitForFunction(() => Number(document.getElementById('s3d-seek').value) === 3000);
    await expectRecovered('track change during native drag cancels old seek');
    await seek.focus();
    await seek.press('ArrowRight');
    await page.waitForFunction(() => window.__stage3dCheck.commands.some(command => command.action === 'seek'));
    assert.equal(await page.evaluate(() => window.__stage3dCheck.commands.filter(command => command.action === 'seek').length), 1);
    pass('keyboard seek works after cancellations');
    await beginDrag();
    await page.mouse.up();
    await page.waitForFunction(() => window.__stage3dCheck.commands.filter(command => command.action === 'seek').length === 2);
    pass('normal native pointer release commits exactly one seek');

    const volume = page.locator('#s3d-volume');
    await volume.focus();
    const volumeBox = await volume.boundingBox();
    assert.ok(volumeBox && volumeBox.width > 10, 'Volume must be visible');
    await page.mouse.move(volumeBox.x + volumeBox.width * 0.25, volumeBox.y + volumeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(volumeBox.x + volumeBox.width * 0.8, volumeBox.y + volumeBox.height / 2, { steps: 5 });
    const volumeCommands = await page.evaluate(() => window.__stage3dCheck.commands.filter(command => command.action === 'volume'));
    assert.ok(volumeCommands.length > 0, 'Volume must submit while pointer remains down');
    assert.equal(volumeCommands.at(-1).value, Number(await volume.inputValue()) / 100);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__stage3dCheck.commands.filter(command => command.action === 'volume').length), volumeCommands.length);
    pass('native volume drag submits before release without duplicate change submission');

    await page.mouse.move(700, 500);
    await page.locator('#s3d-settings-toggle').click();
    await page.locator('#s3d-lyric-visual').selectOption('classic');
    const settings = page.locator('#s3d-settings');
    await settings.evaluate(element => { element.style.maxHeight = '260px'; element.scrollTop = 0; });
    const box = await settings.boundingBox();
    const radiusBefore = await page.evaluate(() => Stage3D.stats().camera.radius);
    await page.mouse.move(box.x + box.width - 18, box.y + box.height / 2);
    await page.mouse.wheel(0, 360);
    await page.waitForFunction(() => document.getElementById('s3d-settings').scrollTop > 0);
    const radiusAfter = await page.evaluate(() => Stage3D.stats().camera.radius);
    assert.ok(Math.abs(radiusBefore - radiusAfter) < 0.05, 'Settings wheel must not zoom camera');
    pass('native wheel scrolls settings without zooming stage');
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.locator('#s3d-settings-close').click();
    await page.evaluate(() => Stage3D.configure({ foliaVisual: 'stage' }));
    const thetaBefore = await page.evaluate(() => Stage3D.stats().camera.theta);
    await page.mouse.move(120, 400);
    await page.mouse.down();
    await page.mouse.move(230, 450, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(before => Math.abs(Stage3D.stats().camera.theta - before) > 0.1, thetaBefore);
    assert.equal(await page.locator('#stage3d').evaluate(element => element.classList.contains('s3d-dragging')), false);
    pass('native canvas drag rotates camera and release clears dragging');
    const zoomBefore = await page.evaluate(() => Stage3D.stats().camera.radius);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(before => Stage3D.stats().camera.radius < before - 0.1, zoomBefore);
    pass('native canvas wheel zooms camera');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const frozenTime = await page.evaluate(() => Stage3D.stats().time);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => Stage3D.stats().time), frozenTime);
    pass('OS reduced motion freezes scene time');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#stage3d').evaluate(element => getComputedStyle(element).touchAction), 'auto');
    await page.screenshot({ path: path.join(output, 'mobile-reduced.png') });
    pass('mobile stage permits native touch scrolling outside gesture surfaces');
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.waitForTimeout(250);
    const large = await page.evaluate(() => Stage3D.stats());
    const [bufferWidth, bufferHeight] = large.buffer.split('x').map(Number);
    assert.ok(bufferWidth * bufferHeight <= [1900000, 3600000, 6200000][large.quality], '4K buffer must stay within quality pixel budget');
    pass('4K viewport respects rendering pixel budget');
    await page.setViewportSize({ width: 1440, height: 960 });
    const sceneStats = [];
    for (const scene of await page.evaluate(() => Stage3D.stages())) {
      await page.evaluate(id => Stage3D.setStageById(id), scene.id);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('#s3d-fallback').isVisible(), false, scene.id + ' must render without fallback');
      sceneStats.push(await page.evaluate(() => Stage3D.stats()));
    }
    pass('all seven existing scenes switch without rendering fallback');
    assert.deepEqual(errors, [], 'Unhandled browser errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ base, localAssets, staleAssets, checks,
      rendering: { baseline, large, sceneStats, note: 'stats are diagnostics, not a cross-device FPS benchmark' },
      lifecycleEvents: 'pointercancel, window blur and hidden are injected; seek drag, key and wheel input use Chromium input',
      playback: 'Stage.presentation fixture; stage controls captured; non-GET API writes mocked', errors }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ base, localAssets, staleAssets, checks, failure: error.message, errors }, null, 2));
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop({ path: path.join(output, 'trace.zip') });
    await browser.close();
  }
  console.log('3D browser checks passed: ' + checks.length + ' (' + (localAssets ? 'local 3D asset overlay' : staleAssets.length ? 'mismatched embedded assets' : 'rebuilt embedded assets') + ')');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
