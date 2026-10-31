// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { startFixture } = require('./ui-browser-fixture');
const web = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/emotion-stage');
const effectKinds = { joy: 'sparkle', sorrow: 'tears', anger: 'flame', anxious: 'electric', tender: 'petals', triumph: 'rays', lonely: 'mist' };

async function startPreview() {
  const fixture = await startFixture();
  try {
    const track = await fixture.seed();
    await fixture.api('/v1/tracks/' + encodeURIComponent(track.id) + '/lyrics', 'PUT', {
      content: '[00:00.00]晚风吹过你的眼睛\n[00:08.00]星光落在你我之间\n[00:16.00]带着光奔向远方\n[00:24.00]留下温柔的回响'
    });
    await fixture.api('/v1/settings', 'PUT', { stage_idle_hide: false, reduce_motion: false, cover_follow: false });
    await fixture.api('/v1/player/load', 'POST', { track_id: track.id });
    await fixture.api('/v1/player/pause', 'POST', {});
    const discovery = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json')));
    const upstream = new URL(fixture.base);
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/v1/')) {
        const proxy = http.request(fixture.base + req.url, { method: req.method,
          headers: { ...req.headers, host: upstream.host, authorization: 'Bearer ' + discovery.token } }, reply => {
          res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
        });
        proxy.on('error', error => { res.writeHead(502); res.end(error.message); });
        req.pipe(proxy); return;
      }
      const file = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end(); return;
      }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      const body = pathname === '/' ? fs.readFileSync(file, 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', discovery.token) : fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => {
      const remote = net.connect(Number(upstream.port), upstream.hostname, () => {
        remote.write('GET ' + req.url + ' HTTP/1.1\r\n' + Object.entries({ ...req.headers,
          host: upstream.host, origin: fixture.base, authorization: 'Bearer ' + discovery.token })
          .map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
        if (head.length) remote.write(head);
        socket.pipe(remote); remote.pipe(socket);
      });
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { fixture, base: 'http://127.0.0.1:' + server.address().port,
      async close() { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); await fixture.close(); } };
  } catch (error) { await fixture.close(); throw error; }
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const preview = await startPreview();
  if (process.argv.includes('--serve')) {
    console.log('Emotion preview: ' + preview.base);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
    return;
  }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-features=LocalNetworkAccessChecks'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.base);
    await page.waitForFunction(() => window.Stage && Stage.lyrics()?.lines.length === 4);
    const modelRequests = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/v1/ai/lyrics/emotion') modelRequests.push(request); });
    await page.evaluate(() => document.body.classList.add('stage-open'));
    await page.locator('.stage > [data-emotion-open]').click();
    await page.waitForSelector('#emotion-dialog[open]');
    for (const id of ['joy', 'sorrow', 'anger', 'anxious', 'tender', 'triumph', 'lonely']) {
      await page.locator('[data-emotion-preview="' + id + '"]').click();
      await page.waitForFunction(id => LyricEmotion.resolveForLine(0).id === id, id);
      assert.equal(await page.locator('#set-emotion-mode').inputValue(), 'manual');
      await page.waitForFunction(() => {
        const sample = document.getElementById('emotion-preview-text');
        const frames = sample._verifiedFrames || (sample._verifiedFrames = new Set());
        frames.add([...sample.children].map(n => n.style.transform).join('|'));
        return frames.size >= 5;
      });
      await page.evaluate(() => { delete document.getElementById('emotion-preview-text')._verifiedFrames; });
      const effect = await page.locator('#emotion-preview-text .emo-glyph-fx').first().evaluate(el => ({
        kind: el.dataset.emotionFx, paths: el.querySelectorAll('path').length, width: el.getBoundingClientRect().width,
        pointer: getComputedStyle(el).pointerEvents
      }));
      assert.equal(effect.kind, effectKinds[id], id + ' preview has a literal glyph effect');
      assert.ok(effect.paths > 0 && effect.width > 10 && effect.pointer === 'none', id + ' effect is visible and cannot block input');
      if (['anger', 'sorrow'].includes(id)) await page.screenshot({ path: path.join(output, 'literal-' + id + '.png') });
    }
    console.log('PASS preview: seven literal glyph effects plus existing font animations');
    assert.equal(modelRequests.length, 0, 'manual preview never sends lyrics to a model');
    await page.locator('#set-emotion-ai-authorized').check();
    await page.waitForFunction(() => !document.querySelector('#set-emotion-mode option[value="auto"]').disabled);
    await page.locator('#set-emotion-mode').selectOption('auto');
    await page.waitForFunction(() => document.getElementById('set-emotion-note').textContent.includes('已应用当前歌词'));
    const beforeRollback = modelRequests.length;
    await page.route('**/v1/settings', route => route.request().method() === 'PUT' && route.request().postDataJSON()?.lyrics_emotion_mode === 'off'
      ? route.fulfill({ status: 503, json: { error: 'fixture save failure' } }) : route.continue());
    await page.locator('#set-emotion-mode').selectOption('off');
    await page.waitForFunction(() => document.getElementById('emotion-save-note').textContent.includes('保存失败'));
    await page.waitForFunction(() => document.getElementById('set-emotion-note').textContent.includes('已应用当前歌词'));
    assert.ok(modelRequests.length > beforeRollback, 'failed off save re-applies automatic cues after rollback');
    await page.unroute('**/v1/settings');
    await page.route('**/v1/ai/lyrics/emotion', route => route.fulfill({ status: 503, json: { error: 'fixture model failure' } }));
    await page.locator('#emotion-retry').click();
    await page.waitForFunction(() => document.getElementById('set-emotion-note').textContent.includes('分析失败'));
    await page.unroute('**/v1/ai/lyrics/emotion');
    await page.locator('#emotion-retry').click();
    await page.waitForFunction(() => document.getElementById('set-emotion-note').textContent.includes('已应用当前歌词'));
    await page.locator('[data-emotion-preview="lonely"]').click();
    await page.waitForFunction(() => document.getElementById('set-emotion-mode').value === 'manual');
    await page.screenshot({ path: path.join(output, 'controls-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'controls-mobile.png') });
    assert.ok(await page.locator('#emotion-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile panel has no horizontal overflow');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#emotion-dialog').evaluate(el => el.open), false, 'Escape closes emotion panel');
    assert.equal(await page.locator('#emotion-controls').count(), 1, 'controls retain one owner');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { Stage.setMode('karaoke'); Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 1 }); });
    await preview.fixture.api('/v1/player/play', 'POST', {});
    await page.waitForFunction(() => Stage.presentation().playing && document.querySelector('.stage-lyrics .lyric.active .word')?.style.getPropertyValue('--emo-scale-y'));
    const sidebarPose = () => page.evaluate(() => [...document.querySelectorAll('.stage-lyrics .lyric.active .word')].map(node => {
      const style = getComputedStyle(node); return [style.translate, style.rotate, style.scale];
    }));
    const sideFirst = await sidebarPose();
    await page.waitForFunction(before => JSON.stringify([...document.querySelectorAll('.stage-lyrics .lyric.active .word')].map(node => {
      const style = getComputedStyle(node); return [style.translate, style.rotate, style.scale];
    })) !== before, JSON.stringify(sideFirst));
    assert.notDeepEqual(await sidebarPose(), sideFirst, 'sidebar follows the advancing media clock');
    await preview.fixture.api('/v1/player/pause', 'POST', {});
    await page.waitForFunction(() => {
      if (Stage.presentation().playing) return false;
      const line = document.querySelector('.stage-lyrics .lyric.active'), words = [...line.querySelectorAll('.word')];
      const token = Stage.lyricTokens(Stage.lyrics().lines[Stage.lyrics().index])[0];
      const progress = Math.max(0, Math.min(1, (Stage.position() - token.start_ms) / Math.max(80, token.end_ms - token.start_ms)));
      const pose = LyricEmotion.motionPose(LyricEmotion.resolveForLine(Stage.lyrics().index), 0.5 / words.length,
        Stage.position() / 1000, parseFloat(getComputedStyle(line).fontSize), Math.sin(progress * Math.PI), false);
      return words[0].style.getPropertyValue('--emo-rotate') === pose.rotate.toFixed(4) + 'rad' &&
        words[0].style.getPropertyValue('--emo-dy') === pose.y.toFixed(3) + 'px' &&
        words[0].style.getPropertyValue('--emo-scale-y') === pose.scaleY.toFixed(4);
    });
    const sidePaused = await sidebarPose();
    const sideFx = await page.locator('.stage-lyrics .lyric.active .emo-glyph-fx').first().innerHTML();
    await page.waitForTimeout(450);
    assert.deepEqual(await sidebarPose(), sidePaused, 'sidebar emotion freezes on pause');
    assert.equal(await page.locator('.stage-lyrics .lyric.active .emo-glyph-fx').first().innerHTML(), sideFx, 'sidebar literal particles freeze on pause');
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'off' }));
    await page.waitForFunction(() => !document.querySelector('.stage-lyrics .lyric.active [style*="--emo-scale-y"]'));
    assert.equal(await page.locator('.stage-lyrics .emo-glyph-fx').count(), 0, 'sidebar clears literal effects when disabled');
    await page.evaluate(() => {
      window.originalEmotionLyrics = Stage.lyrics();
      Stage.setLyrics({ lines: [{ start_ms: 0, end_ms: 8000, text: '啊' }] });
      Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 1 });
    });
    await page.waitForFunction(() => document.querySelector('.stage-lyrics .lyric.active .word')?.style.getPropertyValue('--emo-scale-y'));
    assert.equal(await page.locator('.stage-lyrics .lyric.active .word').count(), 1, 'single-token lyrics also animate');
    await page.evaluate(() => { Stage.setLyrics(originalEmotionLyrics); delete window.originalEmotionLyrics; });
    await page.waitForFunction(() => Stage.lyrics().lines.length === 4);
    console.log('PASS sidebar: real playback motion, pause, off and single-token lyrics');
    await page.evaluate(() => {
      window.emotionClock = 2500;
      const presentation = Stage.presentation;
      Stage.position = () => emotionClock;
      Stage.presentation = () => ({ ...presentation(), position: emotionClock });
      window.emotionEngines = [];
      window.emotionNodes = [];
      const build = StanzaSonnetFx.buildLyrics;
      StanzaSonnetFx.buildLyrics = function (...args) { const nodes = build(...args); emotionNodes = nodes; return nodes; };
      for (const name of ['StanzaClassic', 'StanzaCadenza', 'StanzaSonnet', 'StanzaTempera']) {
        const init = window[name].init;
        window[name].init = function (...args) { const renderer = init(...args); emotionEngines.push(renderer); return renderer; };
      }
      window.paintEmotion = () => { for (const engine of emotionEngines) engine.frame(); };
      Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 1, palette: true });
      Stage3D.configure({ stanzaVisual: 'classic', lyrics: true, stanzaBg: 'stage', shelfMode: 'off' });
      Stage3D.open('aurora');
    });
    await page.waitForFunction(() => LyricEmotion.resolveForLine(0).id === 'joy');
    const snapshots = {};
    for (const mode of ['classic', 'cadenza', 'sonnet', 'tempera']) {
      await page.evaluate(mode => { Stage3D.configure({ stanzaVisual: mode }); Stage.kick(); }, mode);
      await page.waitForSelector('.fl-' + mode + (['sonnet', 'tempera'].includes(mode) ? ' canvas' : ''), { state: 'visible' });
      await page.waitForTimeout(650);
      const seen = new Set();
      for (const id of ['joy', 'sorrow', 'anger', 'anxious', 'tender', 'triumph', 'lonely']) {
        await page.evaluate(id => { Stage.setEmotionSettings({ mode: 'manual', preview: id, scale: 1, palette: true }); }, id);
        await page.waitForFunction(id => LyricEmotion.resolveForLine(0).id === id, id);
        const shot = await page.evaluate(mode => {
          paintEmotion();
          if (mode === 'classic' || mode === 'cadenza') {
            const word = document.querySelector(mode === 'classic' ? '.fl-classic .fl-cword' : '.fl-cadenza .fl-cadz');
            const motion = word.querySelector(mode === 'classic' ? '.fl-emo-motion' : '.fl-body');
            const posed = motion.getBoundingClientRect();
            const transform = motion.style.transform;
            motion.style.transform = 'none';
            const plain = motion.getBoundingClientRect();
            motion.style.transform = transform;
            const fx = motion.querySelector('.emo-glyph-fx');
            return { font: word.style.fontFamily, weight: word.style.fontWeight, transform,
              effect: fx?.dataset.emotionFx, effectVisible: !!fx && getComputedStyle(fx).display !== 'none',
              transformed: ['x', 'y', 'width', 'height'].some(key => Math.abs(posed[key] - plain[key]) > 0.01),
              wallClockAnimations: word.getAnimations({ subtree: true }).map(a => a.animationName).filter(name => /^emo-/.test(name)) };
          }
          const n = emotionNodes[0], fx = n._emotionFx;
          return { font: n.style.fontFamily, weight: n.style.fontWeight, x: n.x, y: n.y,
            effect: fx?.kind, effectVisible: !!fx?.layer.visible && fx.particles.some(p => p.alpha > 0),
            sx: n.scale.x, sy: n.scale.y, skew: n.skew.x, tint: n.tint };
        }, mode);
        assert.ok(shot.font && !shot.font.includes('Inter'), mode + '/' + id + ' selects emotional font');
        assert.equal(shot.effect, effectKinds[id], mode + '/' + id + ' attaches the expected literal effect');
        assert.ok(shot.effectVisible, mode + '/' + id + ' renders its literal effect');
        if (mode === 'classic' || mode === 'cadenza') {
          assert.ok(shot.transform.includes('skewX'), 'DOM consumes shared pose');
          assert.ok(shot.transformed, mode + '/' + id + ' pose changes rendered text geometry');
          assert.deepEqual(shot.wallClockAnimations, [], mode + '/' + id + ' does not layer wall-clock emotion animations over media time');
        } else assert.ok(Number.isFinite(shot.x) && Number.isFinite(shot.sy), 'Pixi consumes finite pose');
        snapshots[mode + '-' + id] = shot;
        if (mode === 'classic') assert.ok(await page.evaluate(() => {
          const words = [...document.querySelectorAll('.fl-classic .fl-cword')].filter(n => n.dataset.st !== 'waiting');
          return words.length > 0 && words.every(n => Number(getComputedStyle(n).opacity) > 0.5);
        }), 'paused preview must show sung words, not freeze transparent waiting transitions');
        seen.add(JSON.stringify(shot));
        if (['sorrow', 'anger', 'joy'].includes(id)) await page.screenshot({ path: path.join(output, mode + '-' + id + '.png') });
      }
      assert.equal(seen.size, 7, mode + ' seven distinct rendered effects');
      const result = await page.evaluate(mode => {
        const read = () => {
          paintEmotion();
          if (mode === 'classic' || mode === 'cadenza') {
            const node = document.querySelector(mode === 'classic' ? '.fl-classic .fl-emo-motion' : '.fl-cadenza .fl-body');
            return node.style.transform + node.querySelector('.emo-glyph-fx').innerHTML;
          }
          return JSON.stringify(emotionNodes.map(n => [n.x, n.y, n.scale.x, n.scale.y, n.skew.x, n.tint,
            n._emotionFx?.particles.map(p => [p.x, p.y, p.scale.x, p.scale.y, p.alpha])]));
        };
        const first = read(); emotionClock = 7200; const advanced = read(); emotionClock = 2500;
        return { first, advanced, returned: read(), repeat: read() };
      }, mode);
      assert.notEqual(result.first, result.advanced, mode + ' animates as media time advances');
      assert.equal(result.first, result.returned, mode + ' seeks to identical emotion pose');
      assert.equal(result.first, result.repeat, mode + ' paused emotion pose stays frozen');
      const reduced = await page.evaluate(mode => {
        const host = document.getElementById('s3d-stanza'); host.classList.add('s3d-reduced');
        const read = () => { paintEmotion(); return mode === 'classic' || mode === 'cadenza'
          ? document.querySelector(mode === 'classic' ? '.fl-classic .fl-emo-motion' : '.fl-cadenza .fl-body').style.transform
          : JSON.stringify(emotionNodes.map(n => [n.x, n.y, n.rotation, n.scale.x, n.scale.y, n.skew.x])); };
        const first = read(); emotionClock = 4000; const second = read(); emotionClock = 2500;
        const effectsHidden = mode === 'classic' || mode === 'cadenza'
          ? [...document.querySelectorAll('.fl-' + mode + ' .emo-glyph-fx')].every(n => getComputedStyle(n).display === 'none')
          : emotionNodes.every(n => !n._emotionFx || !n._emotionFx.layer.visible);
        host.classList.remove('s3d-reduced'); paintEmotion(); return { first, second, effectsHidden };
      }, mode);
      assert.equal(reduced.first, reduced.second, mode + ' reduced motion retains static letterforms');
      assert.ok(reduced.effectsHidden, mode + ' reduced motion suppresses literal particles');
      await page.evaluate(() => Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 0 }));
      await page.waitForFunction(() => LyricEmotion.resolveForLine(0).id === 'neutral');
      await page.evaluate(() => paintEmotion());
      await page.evaluate(() => Stage.setEmotionSettings({ mode: 'off' }));
      const cleared = await page.evaluate(mode => {
        paintEmotion();
        return mode === 'classic' || mode === 'cadenza'
          ? !document.querySelector('.fl-' + mode + ' [data-emo-active="true"], .fl-' + mode + ' .emo-glyph-fx')
          : emotionNodes.every(n => n.style.fontFamily.includes('Inter') && n.skew.x === 0 && !n._emotionFx);
      }, mode);
      assert.ok(cleared, mode + ' off restores original typography');
      console.log('PASS ' + mode + ': seven moods, seek, pause, off');
    }
    await page.evaluate(() => {
      Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 1 });
      Stage3D.configure({ stanzaVisual: 'stage', layout: 'focus' });
      Stage.kick();
    });
    await page.waitForFunction(() => document.querySelector('#s3d-reading .sl-line.is-active .sl-word')?.style.getPropertyValue('--emo-scale-y'));
    const trackFirst = await page.locator('#s3d-reading .sl-line.is-active .sl-word').first().evaluate(n => n.style.getPropertyValue('--emo-dy'));
    await page.evaluate(() => { emotionClock = 4000; Stage.kick(); });
    await page.waitForFunction(before => document.querySelector('#s3d-reading .sl-line.is-active .sl-word').style.getPropertyValue('--emo-dy') !== before, trackFirst);
    await page.evaluate(() => { emotionClock = 2500; Stage.kick(); });
    await page.waitForFunction(before => document.querySelector('#s3d-reading .sl-line.is-active .sl-word').style.getPropertyValue('--emo-dy') === before, trackFirst);
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'off' }));
    await page.waitForFunction(() => !document.querySelector('#s3d-reading [style*="--emo-scale-y"]'));
    console.log('PASS lyric track: media animation, seek and off');
    await page.evaluate(() => {
      window.editorialNodes = [];
      const Text = PIXI.Text;
      PIXI.Text = class extends Text { constructor(options) { super(options); editorialNodes.push(this); } };
      Stage3D.configure({ stanzaVisual: 'sonnet', sonnetTuning: { lyricLayout: 'editorial-track' } });
    });
    await page.waitForFunction(() => editorialNodes.some(n => !n.destroyed && n.dataset?.worldX != null));
    const editorial = new Set();
    for (const id of ['joy', 'sorrow', 'anger', 'anxious', 'tender', 'triumph', 'lonely']) {
      await page.evaluate(id => Stage.setEmotionSettings({ mode: 'manual', preview: id, scale: 1 }), id);
      await page.waitForFunction(id => LyricEmotion.resolveForLine(0).id === id, id);
      const shape = await page.evaluate(() => {
        paintEmotion();
        const n = editorialNodes.find(n => !n.destroyed && n.dataset?.worldX != null);
        return [n.style.fontFamily, n.style.fontWeight, n.x, n.y, n.skew.x, n.scale.x, n.scale.y];
      });
      editorial.add(JSON.stringify(shape));
    }
    assert.equal(editorial.size, 7, 'editorial track also consumes seven distinct emotions');
    await page.goto(preview.base);
    await page.waitForFunction(() => window.Stage && Stage.lyrics()?.lines.length === 4);
    await page.evaluate(() => {
      Stage3D.configure({ stanzaVisual: 'sonnet', lyrics: true, stanzaBg: 'stage', shelfMode: 'off' });
      Stage3D.open('aurora');
    });
    await page.waitForSelector('.fl-sonnet canvas', { state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('stage3d').classList.contains('s3d-chrome'));
    await page.bringToFront();
    const settingsButton = page.locator('#s3d-settings-toggle');
    const settingsBox = await settingsButton.boundingBox();
    await page.mouse.move(settingsBox.x + settingsBox.width / 2, settingsBox.y + settingsBox.height / 2);
    await page.waitForFunction(() => {
      const el = document.getElementById('s3d-settings-toggle'), box = el.getBoundingClientRect();
      return getComputedStyle(el).opacity === '1' && el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => !document.getElementById('s3d-settings').hidden);
    await page.locator('#s3d-settings [data-emotion-open]').click();
    assert.equal(await page.locator('#emotion-dialog').evaluate(el => el.open), true);
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#stage3d').evaluate(el => el.classList.contains('s3d-open')), 'closing controls keeps stage open');
    await page.locator('#s3d-fs').click();
    await page.locator('#s3d-settings [data-emotion-open]').click();
    assert.ok(await page.locator('#emotion-dialog').evaluate(el => el.open && el.parentElement === document.fullscreenElement), 'emotion dialog is usable inside native fullscreen');
    await page.locator('[data-emotion-preview="tender"]').click();
    await page.waitForFunction(() => LyricEmotion.resolveForLine(0).id === 'tender');
    await page.screenshot({ path: path.join(output, 'controls-fullscreen.png') });
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => !document.getElementById('emotion-dialog').open && document.fullscreenElement?.id === 'stage3d'), 'Escape closes only the dialog, not fullscreen');
    await page.locator('#s3d-settings [data-emotion-open]').click();
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => {
      const dialog = document.getElementById('emotion-dialog');
      return dialog.open && dialog.parentElement === document.body;
    });
    await page.locator('#emotion-dialog-close').click();
    await page.waitForFunction(() => !document.getElementById('emotion-dialog').contains(document.getElementById('emotion-controls')));
    assert.equal(await page.locator('#emotion-controls').count(), 1, 'fullscreen exit restores the single settings owner');
    console.log('PASS fullscreen: visible pointer entry, mood selection, Escape, dialog reparenting');
    await page.evaluate(async () => { Stage3D.close(); Space3D.open(); await Space3D.enterStage('coast'); });
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-tab-lyrics').click();
    await page.locator('#sp-console-lyrics [data-emotion-open]').click();
    assert.equal(await page.locator('#emotion-dialog').evaluate(el => el.open), true, 'space console opens same controls');
    await page.locator('[data-emotion-preview="anger"]').click();
    await page.waitForFunction(() => LyricEmotion.resolveForLine(0).id === 'anger');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#emotion-dialog').evaluate(el => el.open), false, 'Escape closes space emotion controls');
    assert.deepEqual(errors, [], 'no browser exceptions');
    console.log('PASS space console: shared controls, mood selection, Escape; no browser exceptions');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ snapshots, editorialVariants: editorial.size, fullscreen: true, spaceConsole: true, errors }, null, 2));
  } finally { await browser.close(); await preview.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
