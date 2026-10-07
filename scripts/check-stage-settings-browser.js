'use strict';
// Full application verification against an isolated null-backend instance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiToken, uiUrl } = require('./ui-token');
const base = process.env.STAGE_VISUAL_URL || 'http://127.0.0.1:18776';
const root = path.join(__dirname, '..');
const out = path.join(root, 'output/playwright/stage-settings');
let token;
async function api(method, endpoint, body) {
  const r = await fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, endpoint + ': ' + r.status);
  return r.status === 204 ? null : r.json();
}
async function main() {
  const health = await fetch(base + '/v1/health').then(r => r.json());
  assert.equal(health.backend, 'null', 'Requires an isolated silent test instance');
  token = uiToken(); fs.mkdirSync(out, { recursive: true });
  for (const file of ['index.html', 'stage3d.js', 'stage-settings.js', 'stage-particles.js', 'stage-particles-gl.js', 'stanza/stanza-theme.js', 'stanza/stanza-starborn.css', 'stanza/stanza.css', 'stanza/stanza-classic.js', 'stanza/stanza-cadenza.js', 'stanza/stanza-sonnet-fx.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js']) {
    if (file === 'index.html') continue; // Token and content fingerprints are injected by the host.
    const served = await fetch(base + '/' + file).then(r => r.text());
    assert.equal(served.replace(/\r\n/g, '\n'), fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8').replace(/\r\n/g, '\n'), 'stale embedded resource: ' + file);
  }
  const fixtures = path.join(out, 'fixtures'); fs.mkdirSync(fixtures, { recursive: true });
  const wav = Buffer.alloc(44 + 8000 * 60 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(fixtures, 'Stage Settings Fixture.wav'), wav);
  fs.writeFileSync(path.join(fixtures, 'Stage Settings Fixture.lrc'), '[00:00.00]晚风吹过你的眼睛\n[00:05.00]星光落在你我之间\n[00:10.00]听见远方温柔的回声\n[00:17.00]让每一颗星都有颜色\n[00:22.00]让每一个梦慢慢发亮\n[00:27.00]我们沿着星光继续向前走\n[00:35.00]让每一颗星都有颜色\n[00:40.00]让每一个梦慢慢发亮\n[00:48.00]直到黎明映亮天际\n');
  await api('POST', '/v1/library/scan', { root: fixtures });
  let track;
  for (let i = 0; i < 80 && !track; i++) {
    track = (await api('GET', '/v1/tracks?limit=200')).tracks.find(t => t.title === 'Stage Settings Fixture');
    if (!track) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(track, 'fixture scanned');
  await api('PUT', '/v1/settings', { cover_follow: false, reduce_motion: false });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Stage3D && document.getElementById('conn').textContent === '服务已连接');
    await api('POST', '/v1/player/load', { track_id: track.id, queue: [track.id] });
    await api('POST', '/v1/player/pause');
    await api('POST', '/v1/player/seek', { position_ms: 7500 });
    await page.waitForFunction(id => Stage.presentation().track?.id === id && Stage.lyrics()?.lines?.length >= 8, track.id);
    await page.evaluate(() => {
      window.__stageRenderers = {};
      for (const [id, module] of [['classic', StanzaClassic], ['cadenza', StanzaCadenza], ['sonnet', StanzaSonnet], ['tempera', StanzaTempera], ['starborn', StanzaStarborn]]) {
        const original = module.init;
        module.init = (...args) => {
          const renderer = original(...args); window.__stageRenderers[id] = renderer;
          if (id === 'starborn') {
            const reset = renderer.reset; window.__directorResets = 0;
            renderer.reset = () => { window.__directorResets++; return reset(); };
          }
          return renderer;
        };
      }
      Theme.apply('mono');
      Stage3D.configure({ stanzaVisual: 'tempera', stanzaBg: 'stage', lyrics: true, shelfMode: 'off' });
      Stage3D.open('aurora');
    });
    await page.waitForFunction(() => document.querySelector('.fl-tempera-canvas'));
    await page.locator('#s3d-settings-toggle').click();
    for (const visual of ['classic', 'cadenza', 'sonnet', 'tempera', 'starborn']) {
      await page.selectOption('#s3d-lyric-visual', visual);
      for (const background of ['stage', 'atmosphere', 'anime', 'geometric', 'fluid', 'solid']) {
        await page.selectOption('#s3d-fl-bg-mode', background);
        await page.waitForTimeout(100);
        const state = await page.evaluate(() => ({ prefs: Stage3D.preferences(),
          dockHidden: document.getElementById('s3d-dock').hidden, scenes: Stage3D.stages().length,
          bloomDisabled: document.getElementById('s3d-bloom').disabled,
          motionDisabled: document.getElementById('s3d-motion').disabled,
          opacityDisabled: document.getElementById('s3d-fl-opacity').disabled,
          layoutDisabled: document.getElementById('s3d-layout').disabled,
          status: document.getElementById('s3d-settings-status').textContent,
          bg: document.getElementById('s3d-fl-bg').style.background }));
        assert.equal(state.prefs.stanzaVisual, visual);
        assert.equal(state.prefs.stanzaBg, background);
        assert.equal(state.dockHidden, background !== 'stage', visual + '/' + background);
        assert.equal(state.scenes > 0, background === 'stage');
        assert.equal(state.bloomDisabled, background !== 'stage');
        assert.equal(state.motionDisabled, false, '2D camera works without a 3D background');
        assert.equal(state.opacityDisabled, background !== 'fluid');
        assert.equal(state.layoutDisabled, true);
        assert.ok(state.status.length > 10);
        if (background !== 'stage') {
          const changed = await page.evaluate(() => Stage3D.setStage(1));
          assert.equal(changed, false, 'hidden scene cannot be selected programmatically');
        }
      }
    }
    console.log('PASS 30 lyric mode/background combinations, dock/API gating and live status');
    await page.selectOption('#s3d-lyric-visual', 'sonnet');
    await page.selectOption('#s3d-fl-bg-mode', 'stage');
    async function range(id, value) {
      await page.locator('#' + id).evaluate((input, v) => { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    }
    await range('s3d-fl-halation', 0);
    await page.waitForFunction(() => !__stageRenderers.sonnet.getDebugSnapshot().halation);
    await range('s3d-fl-halation', 0.5);
    await page.waitForFunction(() => __stageRenderers.sonnet.getDebugSnapshot().halation);
    await page.locator('#s3d-fl-atmosphere').uncheck();
    await page.waitForFunction(() => !__stageRenderers.sonnet.getDebugSnapshot().atmosphereVisible);
    await page.locator('#s3d-fl-atmosphere').check();
    await page.locator('#s3d-fl-decor').uncheck();
    await page.waitForFunction(() => __stageRenderers.sonnet.getDebugSnapshot().atmosphereVisible && !__stageRenderers.sonnet.getDebugSnapshot().decorationsVisible);
    await page.locator('#s3d-fl-decor').check();
    await page.selectOption('#s3d-fl-bg-mode', 'anime');
    for (const id of ['s3d-fl-halation', 's3d-fl-atmosphere', 's3d-fl-accents']) assert.equal(await page.locator('#' + id).isDisabled(), true);
    await page.selectOption('#s3d-fl-bg-mode', 'stage');
    await page.selectOption('#s3d-fl-track-layout', 'lines');
    assert.equal(await page.locator('#s3d-fl-phrase').isDisabled(), true);
    await page.selectOption('#s3d-fl-track-layout', 'phrases');
    assert.equal(await page.locator('#s3d-fl-phrase').isDisabled(), false);
    await page.selectOption('#s3d-lyric-visual', 'tempera');
    await range('s3d-fl-halation-t', 0);
    await page.waitForFunction(() => !__stageRenderers.tempera.getDebugSnapshot().halation);
    await range('s3d-fl-halation-t', 0.5);
    await page.waitForFunction(() => __stageRenderers.tempera.getDebugSnapshot().halation);
    await page.locator('#s3d-fl-seams').uncheck();
    await page.waitForFunction(() => !__stageRenderers.tempera.getDebugSnapshot().seamsVisible);
    await page.locator('#s3d-fl-seams').check();
    await page.waitForFunction(() => __stageRenderers.tempera.getDebugSnapshot().seamsVisible);
    console.log('PASS real DOM controls reach halation, atmosphere, HUD and seams; independent switches combine');
    await page.selectOption('#s3d-fl-color-mode', 'vivid');
    await page.selectOption('#s3d-lyric-visual', 'classic');
    await page.selectOption('#s3d-lyric-visual', 'tempera');
    assert.equal(await page.locator('#s3d-fl-color-mode').inputValue(), 'vivid');
    await page.selectOption('#s3d-fl-bg-mode', 'atmosphere');
    await page.screenshot({ path: path.join(out, 'tempera-settings-desktop.png') });
    console.log('PASS dependent controls and mode-specific preference preservation');
    // Run the real Stage gate, renderer APIs and host against a controlled media clock.
    // Delayed readiness simulates slow WebGL initialization without driver-dependent timing.
    await page.evaluate(() => {
      const clock = window.__handoffClock = { time: 7500, playing: false, ready: false,
        position: Stage.position, presentation: Stage.presentation, isReady: __stageRenderers.sonnet.isReady };
      Stage.position = () => clock.time;
      Stage.presentation = () => ({ ...clock.presentation(), playing: clock.playing });
      Stage3D.configure({ stanzaVisual: 'classic' });
    });
    try {
      await page.waitForFunction(() => !document.querySelector('.fl-hand-out'));
      await page.evaluate(() => {
        __handoffClock.playing = true;
        __stageRenderers.sonnet.isReady = () => __handoffClock.ready && __handoffClock.isReady();
        Stage3D.configure({ stanzaVisual: 'sonnet' });
      });
      await page.waitForTimeout(520);
      assert.equal(await page.evaluate(() => getComputedStyle(__stageRenderers.classic.rootEl()).opacity), '1');
      assert.equal(await page.evaluate(() => __stageRenderers.classic.rootEl().hidden), false);
      await page.evaluate(() => { __handoffClock.ready = true; });
      await page.waitForTimeout(100);
      await page.evaluate(() => { __handoffClock.time += 100; });
      await page.waitForFunction(() => Number(getComputedStyle(__stageRenderers.sonnet.rootEl()).opacity) > 0);
      const fade = await page.evaluate(() => {
        __handoffClock.playing = false;
        return ['classic', 'sonnet'].map(id => getComputedStyle(__stageRenderers[id].rootEl()).opacity);
      });
      await page.waitForTimeout(520);
      assert.deepEqual(await page.evaluate(() => ['classic', 'sonnet'].map(id => getComputedStyle(__stageRenderers[id].rootEl()).opacity)), fade);
      await page.evaluate(() => { __handoffClock.playing = true; __handoffClock.time += 500; });
      await page.waitForFunction(() => __stageRenderers.classic.rootEl().hidden && !document.querySelector('.fl-hand-out'));
      assert.equal(await page.evaluate(() => getComputedStyle(__stageRenderers.sonnet.rootEl()).opacity), '1');
      await page.evaluate(() => { Stage3D.configure({ stanzaVisual: 'classic' }); });
      await page.waitForFunction(() => !!document.querySelector('.fl-hand-out'));
      await page.evaluate(() => { __handoffClock.playing = false; Stage3D.close(); });
      assert.equal(await page.locator('.fl-hand-out, .fl-hand-in').count(), 0, 'closing settles a paused handoff');
      await page.evaluate(() => Stage3D.open());
      await page.waitForFunction(() => !__stageRenderers.classic.rootEl().hidden);
      assert.equal(await page.evaluate(() => getComputedStyle(__stageRenderers.classic.rootEl()).opacity), '1');
      await page.evaluate(() => { __handoffClock.playing = true; Stage3D.configure({ stanzaVisual: 'sonnet' }); });
      await page.waitForFunction(() => !!document.querySelector('.fl-hand-out'));
      await page.evaluate(() => { __handoffClock.playing = false; Stage3D.configure({ stanzaVisual: 'stage' }); });
      assert.equal(await page.locator('.fl-hand-out, .fl-hand-in').count(), 0, '3D layout clears renderer handoff');
      await page.evaluate(() => Stage3D.configure({ stanzaVisual: 'sonnet' }));
      await page.waitForFunction(() => !__stageRenderers.sonnet.rootEl().hidden);
      assert.equal(await page.evaluate(() => getComputedStyle(__stageRenderers.sonnet.rootEl()).opacity), '1');
      await page.locator('#s3d-settings-toggle').click();
      console.log('PASS real Stage frame gate and renderer handoff: delayed readiness, media-clock fade, pause and cleanup');
    } finally {
      await page.evaluate(() => {
        Stage.position = __handoffClock.position; Stage.presentation = __handoffClock.presentation;
        __stageRenderers.sonnet.isReady = __handoffClock.isReady;
        delete window.__handoffClock;
      });
    }
    await page.selectOption('#s3d-lyric-visual', 'starborn');
    await api('POST', '/v1/player/play');
    await page.waitForFunction(() => document.getElementById('stage3d').classList.contains('s3d-starborn') && Number(document.getElementById('stage3d').style.getPropertyValue('--sb-light')) > 0);
    await page.waitForTimeout(400);
    await api('POST', '/v1/player/pause');
    await page.waitForTimeout(250);
    const film = () => page.evaluate(() => ['light', 'light-x', 'light-y', 'transition'].map(k => document.getElementById('stage3d').style.getPropertyValue('--sb-' + k)));
    const frozen = await film(); await page.waitForTimeout(250); assert.deepEqual(await film(), frozen);
    await page.locator('#s3d-fl-vignette').uncheck();
    assert.equal(await page.locator('.s3d-starborn-grade').evaluate(el => getComputedStyle(el, '::before').opacity), '0');
    await page.locator('#s3d-fl-vignette').check();
    const resets = await page.evaluate(() => window.__directorResets);
    await page.selectOption('#s3d-lyric-visual', 'stage');
    assert.equal(await page.evaluate(() => window.__directorResets), resets + 1);
    await page.selectOption('#s3d-lyric-visual', 'starborn');
    await page.waitForFunction(() => __stageRenderers.starborn.cinemaFrame() != null);
    await page.locator('#s3d-settings-close').click();
    await page.screenshot({ path: path.join(out, 'starborn-desktop.png') });
    console.log('PASS starborn cinematic host wiring and pause freeze');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#s3d-settings-toggle').click();
    await page.selectOption('#s3d-lyric-visual', 'tempera');
    await page.waitForFunction(() => document.getElementById('s3d-settings').getAnimations().every(a => a.playState === 'finished'));
    await page.screenshot({ path: path.join(out, 'tempera-settings-mobile.png') });
    assert.ok(await page.evaluate(() => document.getElementById('s3d-settings').getBoundingClientRect().right <= innerWidth + 1));
    await page.evaluate(() => Stage3D.configure({ stanzaVisual: 'stage' }));
    assert.equal(await page.locator('#s3d-layout').isDisabled(), false);
    assert.equal(await page.locator('#s3d-dock').isVisible(), true);
    assert.equal(await page.evaluate(() => Stage3D.preferences().stanzaBg), 'atmosphere');
    assert.equal(await page.evaluate(() => Stage3D.stageId()), 'aurora');
    console.log('PASS mobile settings fit and restoring 3D retains scene/background preferences');
    await page.selectOption('#s3d-lyric-visual', 'tempera');
    let saved;
    for (let attempt = 0; attempt < 80; attempt++) {
      saved = await api('GET', '/v1/settings');
      if (saved.stage3d?.stanzaVisual === 'tempera' && saved.stage3d?.temperaTuning?.colorMode === 'vivid') break;
      await page.waitForTimeout(100);
    }
    assert.equal(saved.stage3d.stanzaVisual, 'tempera');
    await page.reload();
    await page.waitForFunction(() => window.Stage3D && Stage3D.preferences().stanzaVisual === 'tempera');
    const restored = await page.evaluate(() => Stage3D.preferences());
    assert.equal(restored.temperaTuning.colorMode, 'vivid');
    assert.equal(restored.temperaTuning.halation, 0.5);
    assert.equal(restored.temperaTuning.seams, true);
    assert.equal(restored.stanzaBg, 'atmosphere');
    assert.equal(restored.scene, 'aurora');
    console.log('PASS server persistence and reload restore the complete mode/background/effect preferences');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ errors, combinations: 30, status: 'passed' }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
