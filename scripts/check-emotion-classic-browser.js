// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// classic stanza 情绪层浏览器检查：真实 Stage3D + StanzaClassic + LyricEmotion。
// 验证当前行的场位移、配色、字重/字距，以及清除后的默认观感。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-emotion-classic-browser.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const root = path.join(__dirname, '..');
const out = path.join(root, 'output', 'emotion-classic');
const LRC = [
  '[00:00.00]晚风 吹过 你的 眼睛',
  '[00:05.00]星光 落在 你我 之间'
].join('\n');

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')';
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const fixture = await startFixture({ backend: 'null' });
  let browser = null;
  try {
    const track = await fixture.seed();
    await fixture.api('/v1/tracks/' + encodeURIComponent(track.id) + '/lyrics', 'PUT', { content: LRC });
    await fixture.api('/v1/settings', 'PUT', { stage_idle_hide: false, cover_follow: false, reduce_motion: false });
    await fixture.api('/v1/player/load', 'POST', { track_id: track.id, queue: [track.id] });
    await fixture.api('/v1/player/pause', 'POST', {});
    await fixture.api('/v1/player/seek', 'POST', { position_ms: 500 });

    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      headless: process.env.GLYPH_HEADED !== '1'
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await fixture.connect(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.base + '/');
    await page.waitForFunction(() => window.Stage3D && Stage.lyrics() && Stage.lyrics().lines.length >= 2, null, { timeout: 30000 });
    await page.evaluate(() => {
      Stage3D.configure({ stanzaVisual: 'classic', stanzaBg: 'stage', lyrics: true, shelfMode: 'off' });
      Stage3D.open('aurora');
    });
    await page.waitForFunction(() => document.querySelector('.fl-classic .fl-cword'), null, { timeout: 20000 });

    const prepared = await page.evaluate(async () => {
      const lines = Stage.lyrics().lines.map((line) => ({ start_ms: line.start_ms, text: line.text }));
      const bound = await LyricEmotion.bindLyrics({ lines });
      window.__classicHash = bound.hash;
      const index = Stage.lyrics().index;
      const accepted = Stage.setEmotionCueDoc({
        version: 1, lyricsHash: bound.hash, source: 'fixture',
        lines: [{ index, emotion: 'joy', intensity: 1, confidence: 1 }]
      });
      return { hash: bound.hash, index, accepted };
    });
    if (!prepared.accepted) throw new Error('Stage.setEmotionCueDoc 未接受');

    async function apply(id) {
      const accepted = await page.evaluate((emotion) => Stage.setEmotionCueDoc({
        version: 1, lyricsHash: window.__classicHash, source: 'fixture',
        lines: [{ index: Stage.lyrics().index, emotion, intensity: 1, confidence: 1 }]
      }), id);
      if (!accepted) throw new Error('setEmotionCueDoc 拒绝 ' + id);
      await page.waitForFunction((emotion) => {
        const line = document.querySelector('.fl-classic .fl-cline[data-emo-active="true"]');
        return line && line.getAttribute('data-emotion') === emotion;
      }, id, { timeout: 15000 });
      await page.waitForTimeout(120);
      return page.evaluate(() => {
        const line = document.querySelector('.fl-classic .fl-cline[data-emo-active="true"]');
        const words = Array.from(line.querySelectorAll('.fl-cword'));
        const waiting = words.find((w) => w.dataset.st === 'waiting');
        const active = words.find((w) => w.dataset.st === 'active');
        const state = LyricEmotion.resolveForLine(Stage.lyrics().index, { host: 'classic' });
        return {
          emotion: line.getAttribute('data-emotion'),
          words: words.length,
          profile: state && state.id,
          intensity: state && state.intensity,
          palette: state && state.palette,
          dy: words.map((w) => getComputedStyle(w).getPropertyValue('--emo-dy').trim()),
          translate: words.map((w) => getComputedStyle(w).translate),
          animation: words.map((w) => getComputedStyle(w).animationName),
          weight: words.map((w) => getComputedStyle(w).fontWeight),
          spacing: words.map((w) => getComputedStyle(w).letterSpacing),
          waitingColor: waiting ? getComputedStyle(waiting.querySelector('.fl-body')).color : null,
          activeColor: active ? getComputedStyle(active.querySelector('.fl-body')).color : null
        };
      });
    }

    const snapshots = {};
    for (const id of ['joy', 'sorrow', 'anger']) {
      const snapshot = await apply(id);
      if (snapshot.emotion !== id || snapshot.profile !== id) throw new Error('classic 未解析到 ' + id);
      if (!snapshot.words) throw new Error('classic 没有词节点');
      if (!snapshot.dy.every((v) => /^-?\d+(\.\d+)?px$/.test(v))) throw new Error('classic --emo-dy 非 px：' + JSON.stringify(snapshot.dy));
      if (!snapshot.dy.some((v) => Math.abs(parseFloat(v)) > 0.01)) throw new Error(id + ' 场位移全为 0');
      if (!snapshot.translate.some((v) => v && v !== 'none')) throw new Error(id + ' 没有 translate');
      const expectedWeight = id === 'sorrow' ? '400' : '700';
      if (!snapshot.weight.every((w) => w === expectedWeight)) throw new Error(id + ' 字重错误：' + snapshot.weight.join('/'));
      if (id === 'anger' && !(parseFloat(snapshot.spacing[0]) < 0)) throw new Error('anger 字距应为负');
      if (id !== 'anger' && !(parseFloat(snapshot.spacing[0]) > 0)) throw new Error(id + ' 字距应为正');
      if (snapshot.waitingColor !== rgb(snapshot.palette.ink)) {
        throw new Error(id + ' 等待字色 ' + snapshot.waitingColor + ' != ' + rgb(snapshot.palette.ink));
      }
      if (snapshot.activeColor !== rgb(snapshot.palette.accent)) {
        throw new Error(id + ' 活动字色 ' + snapshot.activeColor + ' != ' + rgb(snapshot.palette.accent));
      }
      var expectedAnim = { joy: 'emo-bob', sorrow: 'emo-sink', anger: 'emo-impact' }[id];
      if (!snapshot.animation.every((a) => a === expectedAnim)) {
        throw new Error(id + ' 循环动画错误：' + snapshot.animation.join('/'));
      }
      snapshots[id] = snapshot;
      // 500ms 时只有开头几个词可见；跳到行尾让整行进入 passed/active，便于看场形状。
      await fixture.api('/v1/player/seek', 'POST', { position_ms: 4300 });
      await page.waitForTimeout(280);
      await page.screenshot({ path: path.join(out, id + '.png'), fullPage: false });
      await fixture.api('/v1/player/seek', 'POST', { position_ms: 500 });
      await page.waitForTimeout(180);
    }

    // 减少动效：循环必须停，但静态场位移必须保留。
    const reduced = await page.evaluate(() => {
      document.body.classList.add('reduce-motion');
      const word = document.querySelector('.fl-classic .fl-cword');
      const result = {
        animation: getComputedStyle(word).animationName,
        translate: getComputedStyle(word).translate,
        dy: getComputedStyle(word).getPropertyValue('--emo-dy').trim()
      };
      document.body.classList.remove('reduce-motion');
      return result;
    });
    if (reduced.animation !== 'none' || reduced.translate === 'none' || !reduced.dy) {
      throw new Error('减少动效下未保留静态场或未停循环：' + JSON.stringify(reduced));
    }

    await page.evaluate(() => Stage.clearEmotionCues());
    await page.waitForFunction(() => !document.querySelector('.fl-classic .fl-cline[data-emo-active="true"]'), null, { timeout: 10000 });    const cleared = await page.evaluate(() => {
      const line = document.querySelector('.fl-classic .fl-cline');
      return line ? {
        active: line.hasAttribute('data-emo-active'),
        dy: Array.from(line.querySelectorAll('.fl-cword')).map((w) => getComputedStyle(w).getPropertyValue('--emo-dy').trim()),
        translate: Array.from(line.querySelectorAll('.fl-cword')).map((w) => getComputedStyle(w).translate)
      } : null;
    });
    if (!cleared || cleared.active || cleared.dy.some(Boolean) || cleared.translate.some((v) => v !== 'none')) {
      throw new Error('清除后 classic 仍残留情绪：' + JSON.stringify(cleared));
    }

    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      hash: prepared.hash,
      line: prepared.index,
      snapshots,
      cleared,
      pageErrors: errors
    }, null, 2));

    console.log('✓ classic P1：joy/sorrow/anger 写入场位移、translate、配色、字重/字距；清除后恢复默认');
    console.log('  hash ' + prepared.hash + ' line ' + prepared.index + ' words ' + snapshots.joy.words);
    console.log('  weights ' + [snapshots.joy.weight[0], snapshots.sorrow.weight[0], snapshots.anger.weight[0]].join('/') +
      '  spacing ' + [snapshots.joy.spacing[0], snapshots.sorrow.spacing[0], snapshots.anger.spacing[0]].join('/'));
    if (errors.length) throw new Error('页面异常：' + errors.join('；'));
    console.log('  证据: ' + path.relative(root, out));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fixture.close();
  }
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message || err));
  process.exit(1);
});
