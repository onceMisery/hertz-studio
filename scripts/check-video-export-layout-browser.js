// SPDX-License-Identifier: MIT
// Real Chromium canvas layout check with a lightweight MediaRecorder stub.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const track = await fixture.seed();
  const longMetadataTitle = 'Long Export Metadata ' + '标题'.repeat(80);
  const longMetadataArtist = 'Artist ' + '歌手'.repeat(80);
  await fixture.api('/v1/tracks/batch-edit', 'POST', {
    track_ids: [track.id], title: longMetadataTitle, artist: longMetadataArtist,
  });
  await fixture.api('/v1/player/load', 'POST', { track_id: track.id });
  await fixture.api('/v1/player/pause', 'POST', {});
  await fixture.api('/v1/player/seek', 'POST', { position_ms: 0 });
  const currentLyric = 'Hertz video export lyric sentinel 这一句混合中英文的长歌词用于验证导出不会被横向压扁 '.repeat(5);
  const nextLyric = 'Next lyric 下一句较长的歌词也需要按画布宽度换行保持清晰 '.repeat(5);
  await fixture.api(`/v1/tracks/${encodeURIComponent(track.id)}/lyrics`, 'PUT', {
    content: '[00:00.00]' + currentLyric + '\n[00:05.00]' + nextLyric,
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await fixture.connect(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/video-export.js*', route => route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(path.resolve(__dirname, '../plugin/ui/video-export.js'), 'utf8'),
    }));
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.VideoExport && window.Stage3D);
    await page.evaluate(() => {
      window.layoutCanvases = [];
      window.layoutCanvasTexts = [];
      window.outputLyricDraws = { current: [], next: [] };
      window.outputWatermarkDraws = [];
      window.layoutWatermarkPrefix = 'Long Export Metadata ';
      const fetch = window.fetch;
      window.fetch = function (...args) {
        const response = fetch.apply(this, args);
        if (String(args[0]).includes('/v1/overlay/lyric')) {
          response.then(reply => reply.clone().json().then(data => { window.layoutLyricSnapshot = data; }))
            .catch(() => {});
        }
        return response;
      };
      const capture = HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream = function (...args) {
        const stream = capture.apply(this, args);
        window.layoutCanvases.push(this);
        return stream;
      };
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor(stream, options) {
          this.stream = stream;
          this.mimeType = options.mimeType;
          this.state = 'inactive';
        }
        start() {
          this.state = 'recording';
          setTimeout(() => { if (this.onstart) this.onstart(); }, 0);
        }
        stop() {
          this.state = 'inactive';
          setTimeout(() => { if (this.onstop) this.onstop(); }, 0);
        }
      };
      const fillRect = CanvasRenderingContext2D.prototype.fillRect;
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      let group = null;
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        if (this.canvas === window.layoutCanvases.at(-1)) group = 'current';
        return fillRect.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        if (this.canvas === window.layoutCanvases.at(-1)) {
          const text = String(args[0]);
          if (text.startsWith(window.layoutWatermarkPrefix)) {
            const metrics = this.measureText(text);
            window.outputWatermarkDraws.push({
              text,
              width: metrics.width,
              top: args[2] - metrics.actualBoundingBoxAscent,
              bottom: args[2] + metrics.actualBoundingBoxDescent,
              height: this.canvas.height,
              maxWidth: this.canvas.width - 2 * Math.round(this.canvas.width * 0.04),
              args: args.length,
            });
            return fillText.apply(this, args);
          }
          window.layoutCanvasTexts.push(text);
          if (text.startsWith('Next lyric')) group = 'next';
          else if (text.startsWith('Layout Audit Fixture')) group = 'current';
          if (group && !text.startsWith('Layout Audit Fixture')) {
            const metrics = this.measureText(text);
            const row = {
              text,
              y: args[2],
              top: args[2] - metrics.actualBoundingBoxAscent,
              bottom: args[2] + metrics.actualBoundingBoxDescent,
              height: this.canvas.height,
              width: metrics.width,
              maxWidth: this.canvas.width * (group === 'current' ? 0.88 : 0.84),
              args: args.length,
            };
            if (!window.outputLyricDraws[group].some(existing => existing.text === row.text && existing.y === row.y)) {
              window.outputLyricDraws[group].push(row);
            }
          }
        }
        return fillText.apply(this, args);
      };
      Stage3D.configure({ sceneSource: 'immersive', stanzaVisual: 'stage', stanzaBg: 'stage' });
      Stage3D.open();
    });
    await page.waitForFunction(() => Stage3D.recordingSurface()?.canvas.width > 0);

    async function checkPreset(preset, height, limits, expectTruncation) {
      await page.evaluate(id => {
        window.outputLyricDraws = { current: [], next: [] };
        window.outputWatermarkDraws = [];
        window.recordingError = null;
        window.recordingDone = VideoExport.begin({ preset: { id }, format: 'auto' });
        window.recordingDone.catch(error => { window.recordingError = error.message; });
      }, preset);
      await page.waitForFunction(() => VideoExport.status().phase === 'recording' || window.recordingError,
        null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.recordingError || VideoExport.status().phase), 'recording');
      await page.waitForFunction(() => window.outputLyricDraws.current.length && window.outputLyricDraws.next.length,
        null, { timeout: 8000 }).catch(async error => {
          console.error('Lyric capture state:', JSON.stringify(await page.evaluate(() => ({
            status: VideoExport.status(), snapshot: window.layoutLyricSnapshot && {
              title: layoutLyricSnapshot.title, lines: layoutLyricSnapshot.lines && layoutLyricSnapshot.lines.length,
              positionMs: layoutLyricSnapshot.position_ms, playing: layoutLyricSnapshot.playing,
            }, texts: layoutCanvasTexts.slice(-10),
            rows: window.outputLyricDraws,
            canvases: window.layoutCanvases.map(canvas => [canvas.width, canvas.height]),
          }))));
          throw error;
        });
      const layout = await page.evaluate(() => window.outputLyricDraws);
      for (const [group, limit] of [['current', limits.current], ['next', limits.next]]) {
        assert.ok(layout[group].length > 1, group + ' long lyric must wrap into multiple rows');
        assert.ok(layout[group].length <= limit, group + ' rows must fit its vertical budget');
        assert.ok(layout[group].every(row => row.args === 3), group + ' lyric must not use maxWidth compression');
        assert.ok(layout[group].every(row => row.width <= row.maxWidth + 1), group + ' rows must fit the safe width');
        assert.ok(layout[group].every(row => row.top >= 0 && row.bottom <= height && row.height === height),
          group + ' glyph bounds must stay inside the canvas');
        if (expectTruncation) {
          assert.ok(layout[group].some(row => row.text.endsWith('…')), group + ' overflow must end with an ellipsis');
        }
      }
      const watermark = await page.evaluate(() => window.outputWatermarkDraws.at(-1));
      assert.ok(watermark, 'long track metadata must be drawn as a watermark');
      assert.ok(watermark.text.endsWith('…'), 'long track metadata is visibly truncated: ' + JSON.stringify(watermark));
      assert.ok(watermark.args === 3, 'watermark text is truncated without horizontal compression');
      assert.ok(watermark.width <= watermark.maxWidth + 1, 'watermark remains inside the horizontal safe area');
      assert.ok(watermark.top >= 0 && watermark.bottom <= height && watermark.height === height,
        'watermark glyph bounds stay inside the canvas');
      const currentBottom = Math.max(...layout.current.map(row => row.bottom));
      const nextTop = Math.min(...layout.next.map(row => row.top));
      assert.ok(currentBottom < nextTop, 'current and next lyric glyphs must not overlap');
      await page.evaluate(async () => { await VideoExport.stop(); await recordingDone; });
    }

    await checkPreset('720p', 720, { current: 3, next: 2 }, false);
    await checkPreset('portrait', 1920, { current: 3, next: 2 }, true);
    assert.deepEqual(errors, []);
    console.log('PASS Chromium lyric rows stay in bounds, truncate overflow, and keep current/next text separate');
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
