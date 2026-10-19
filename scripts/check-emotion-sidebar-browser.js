// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 侧栏 P0 浏览器检查：真实隔离服务 + 真实 Stage。
// 注入一份 Cue 后，只验证当前行/词的 data-* 与 --emo-dy；P0 不消费视觉。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-emotion-sidebar-browser.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const root = path.join(__dirname, '..');
const out = path.join(root, 'output', 'emotion-sidebar');
const LRC = [
  '[00:00.00]晚风 吹过 你的 眼睛',
  '[00:05.00]星光 落在 你我 之间'
].join('\n');

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const fixture = await startFixture({ backend: 'null' });
  let browser = null;
  try {
    const track = await fixture.seed();
    await fixture.api('/v1/tracks/' + encodeURIComponent(track.id) + '/lyrics', 'PUT', { content: LRC });
    await fixture.api('/v1/player/load', 'POST', { track_id: track.id, queue: [track.id] });
    await fixture.api('/v1/player/pause', 'POST', {});
    await fixture.api('/v1/player/seek', 'POST', { position_ms: 500 });
    await fixture.api('/v1/settings', 'PUT', { stage_idle_hide: false });

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
    await page.waitForFunction(() => window.Stage && Stage.lyrics() && Stage.lyrics().lines.length >= 2, null, { timeout: 30000 });
    await page.evaluate(() => {
      if (Stage.setMode) Stage.setMode('karaoke');
      // classic / ios / sheen 皮肤默认把舞台收成抽屉；测试要量侧栏，显式打开。
      document.body.classList.add('stage-open', 'sheen-mini-open');
    });
    // 空闲后整个舞台会被 data-stage-idle 隐藏；指针动一下唤醒。
    async function wake() {
      await page.mouse.move(720, 500);
      await page.mouse.move(721, 501);
      await page.waitForTimeout(60);
    }
    await wake();
    await page.waitForFunction(() => {
      const stage = document.querySelector('.stage');
      return stage && getComputedStyle(stage).display !== 'none';
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.stage-lyrics .lyric.active'), null, { timeout: 10000 });

    const before = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return {
        emotion: line ? line.getAttribute('data-emotion') : null,
        words: line ? Array.from(line.querySelectorAll('.word')).length : 0,
        dy: line ? Array.from(line.querySelectorAll('.word')).map((w) => getComputedStyle(w).getPropertyValue('--emo-dy')) : []
      };
    });
    if (before.emotion !== null) throw new Error('无 Cue 时侧栏不应有 data-emotion');

    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'auto' }));
    const prepared = await page.evaluate(async () => {
      const lines = Stage.lyrics().lines.map((line) => ({ start_ms: line.start_ms, text: line.text }));
      const bound = await LyricEmotion.bindLyrics({ lines });
      const index = Stage.lyrics().index;
      window.__sidebarHash = bound.hash;
      const doc = {
        version: 1, lyricsHash: bound.hash, source: 'fixture',
        lines: [{ index, emotion: 'joy', intensity: 1, confidence: 1 }]
      };
      return { hash: bound.hash, index, accepted: Stage.setEmotionCueDoc(doc) };
    });
    if (!prepared.accepted) throw new Error('Stage.setEmotionCueDoc 未接受');

    async function apply(id) {
      const accepted = await page.evaluate((emotion) => Stage.setEmotionCueDoc({
        version: 1, lyricsHash: window.__sidebarHash, source: 'fixture',
        lines: [{ index: Stage.lyrics().index, emotion, intensity: 1, confidence: 1 }]
      }), id);
      if (!accepted) throw new Error('setEmotionCueDoc 拒绝 ' + id);
      await page.waitForFunction((emotion) => {
        const line = document.querySelector('.stage-lyrics .lyric.active');
        return line && line.getAttribute('data-emotion') === emotion;
      }, id, { timeout: 15000 });
      await page.waitForTimeout(80);
      return page.evaluate(() => {
        const line = document.querySelector('.stage-lyrics .lyric.active');
        const words = Array.from(line.querySelectorAll('.word'));
        const cs = getComputedStyle(line);
        return {
          emotion: line.getAttribute('data-emotion'),
          active: line.getAttribute('data-emo-active'),
          intensity: getComputedStyle(line).getPropertyValue('--emo-i').trim(),
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing,
          lineHeight: cs.lineHeight,
          words: words.length,
          dy: words.map((w) => getComputedStyle(w).getPropertyValue('--emo-dy').trim()),
          translate: words.map((w) => getComputedStyle(w).translate)
        };
      });
    }

    const snapshots = {};
    for (const id of ['joy', 'sorrow', 'anger']) {
      await wake();
      const snapshot = await apply(id);
      if (snapshot.emotion !== id || snapshot.active !== 'true') throw new Error('侧栏未写入 ' + id);
      if (!snapshot.words) throw new Error('侧栏没有可测的词节点');
      if (!snapshot.dy.every((v) => /^-?\d+(\.\d+)?px$/.test(v))) throw new Error('--emo-dy 不是 px：' + JSON.stringify(snapshot.dy));
      if (!snapshot.dy.some((v) => Math.abs(parseFloat(v)) > 0.01)) throw new Error(id + ' 的 --emo-dy 全为 0');
      if (!snapshot.translate.some((v) => v && v !== 'none' && Math.abs(parseFloat(v.split(' ').pop())) > 0.01)) {
        throw new Error(id + ' 的词没有实际 translate');
      }
      snapshots[id] = snapshot;
      await page.screenshot({ path: path.join(out, id + '.png'), fullPage: false });
    }
    if (snapshots.joy.fontWeight !== '700' || snapshots.sorrow.fontWeight !== '400' ||
        snapshots.anger.fontWeight !== '700') {
      throw new Error('字体参数未按情绪映射：' + JSON.stringify({
        joy: snapshots.joy.fontWeight, sorrow: snapshots.sorrow.fontWeight, anger: snapshots.anger.fontWeight
      }));
    }
    if (!(parseFloat(snapshots.joy.letterSpacing) > 0) ||
        !(parseFloat(snapshots.anger.letterSpacing) < 0)) {
      throw new Error('字距未按情绪映射：' + JSON.stringify({
        joy: snapshots.joy.letterSpacing, sorrow: snapshots.sorrow.letterSpacing, anger: snapshots.anger.letterSpacing
      }));
    }
    await page.screenshot({ path: path.join(out, 'overlay.png'), fullPage: false });

    await page.evaluate(() => Stage.clearEmotionCues());
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && !line.hasAttribute('data-emotion') &&
        Array.from(line.querySelectorAll('.word')).every((w) => !w.style.getPropertyValue('--emo-dy'));
    }, null, { timeout: 10000 });
    const cleared = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return {
        emotion: line.getAttribute('data-emotion'),
        letterSpacing: getComputedStyle(line).letterSpacing,
        translate: Array.from(line.querySelectorAll('.word')).map((w) => getComputedStyle(w).translate)
      };
    });
    if (cleared.letterSpacing !== 'normal' || cleared.translate.some((v) => v !== 'none')) {
      throw new Error('清除后仍残留视觉参数：' + JSON.stringify(cleared));
    }

    const offRejected = await page.evaluate(() => {
      Stage.setEmotionSettings({ mode: 'off' });
      return Stage.setEmotionCueDoc({
        version: 1, lyricsHash: window.__sidebarHash, source: 'fixture',
        lines: [{ index: Stage.lyrics().index, emotion: 'anger', intensity: 1, confidence: 1 }]
      });
    });
    if (offRejected) throw new Error('off 模式仍接受自动 Cue');

    // 设置路径：manual 预览 -> 关闭 -> scale=0 中性 -> palette 关闭。
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'manual', preview: 'sorrow', scale: 1, palette: true }));
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.getAttribute('data-emotion') === 'sorrow';
    }, null, { timeout: 15000 });
    const settingsSorrow = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return { emotion: line.getAttribute('data-emotion'), weight: getComputedStyle(line).fontWeight };
    });
    if (settingsSorrow.emotion !== 'sorrow' || settingsSorrow.weight !== '400') {
      throw new Error('设置 manual 预览未生效：' + JSON.stringify(settingsSorrow));
    }
    const manualRejected = await page.evaluate(() => Stage.setEmotionCueDoc({
      version: 1, lyricsHash: window.__sidebarHash, source: 'fixture',
      lines: [{ index: Stage.lyrics().index, emotion: 'anger', intensity: 1, confidence: 1 }]
    }));
    if (manualRejected) throw new Error('manual 模式仍接受自动 Cue');
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'off' }));
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && !line.hasAttribute('data-emotion');
    }, null, { timeout: 10000 });
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 0, palette: true }));
    await page.waitForTimeout(250);
    if (await page.evaluate(() => document.querySelector('.stage-lyrics .lyric.active').hasAttribute('data-emotion'))) {
      throw new Error('scale=0 仍写情绪属性');
    }
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'manual', preview: 'joy', scale: 1, palette: false }));
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.getAttribute('data-emotion') === 'joy';
    }, null, { timeout: 15000 });
    const noPalette = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return { ink: line.style.getPropertyValue('--emo-ink'), dy: Array.from(line.querySelectorAll('.word')).map((w) => getComputedStyle(w).getPropertyValue('--emo-dy').trim()) };
    });
    if (noPalette.ink || !noPalette.dy.some((v) => Math.abs(parseFloat(v)) > 0.01)) {
      throw new Error('palette=off 未只关闭配色：' + JSON.stringify(noPalette));
    }
    await page.evaluate(() => Stage.setEmotionSettings({ mode: 'off' }));

    // 设置抽屉真实 UI：manual + sorrow 落库并生效，再切回 off。
    await page.evaluate(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); });
    await page.waitForFunction(() => {
      const v = document.getElementById('view-settings');
      return v && !v.hidden && getComputedStyle(v).display !== 'none';
    }, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.querySelector('.skset-link[data-skset-key="lyrics"]'); if (b) b.click(); });
    await page.waitForTimeout(150);
    await page.selectOption('#set-emotion-mode', 'manual');
    await page.waitForTimeout(300);
    await page.selectOption('#set-emotion-preview', 'sorrow');
    await page.waitForTimeout(400);
    await page.evaluate(() => { const b = document.querySelector('.skset-modal-close'); if (b) b.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.body.classList.add('stage-open'));
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.getAttribute('data-emotion') === 'sorrow';
    }, null, { timeout: 15000 });
    const fromUi = await page.evaluate(() => ({
      emotion: document.querySelector('.stage-lyrics .lyric.active').getAttribute('data-emotion'),
      mode: document.getElementById('set-emotion-mode').value
    }));
    if (fromUi.emotion !== 'sorrow' || fromUi.mode !== 'manual') {
      throw new Error('设置抽屉未把 manual/sorrow 接到舞台：' + JSON.stringify(fromUi));
    }
    await page.evaluate(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); });
    await page.waitForFunction(() => {
      const v = document.getElementById('view-settings');
      return v && !v.hidden && getComputedStyle(v).display !== 'none';
    }, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.querySelector('.skset-link[data-skset-key="lyrics"]'); if (b) b.click(); });
    await page.waitForTimeout(150);
    await page.selectOption('#set-emotion-mode', 'off');
    await page.evaluate(() => { const b = document.querySelector('.skset-modal-close'); if (b) b.click(); });
    await page.waitForTimeout(200);
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && !line.hasAttribute('data-emotion');
    }, null, { timeout: 15000 });

    // 无真实 key 的 auto 端到端：默认 fake provider + 显式授权，应能返回 fixture cues。
    await page.evaluate(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); });
    await page.waitForFunction(() => {
      const v = document.getElementById('view-settings');
      return v && !v.hidden && getComputedStyle(v).display !== 'none';
    }, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.querySelector('.skset-link[data-skset-key="lyrics"]'); if (b) b.click(); });
    await page.waitForTimeout(150);
    await page.check('#set-emotion-ai-authorized');
    await page.waitForTimeout(500);
    const autoEnabled = await page.evaluate(() => {
      const option = document.querySelector('#set-emotion-mode option[value="auto"]');
      return option ? !option.disabled : false;
    });
    if (!autoEnabled) throw new Error('fake provider + 授权后 auto 仍不可用');
    await page.selectOption('#set-emotion-mode', 'auto');
    await page.evaluate(() => { const b = document.querySelector('.skset-modal-close'); if (b) b.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.body.classList.add('stage-open'));
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.hasAttribute('data-emotion');
    }, null, { timeout: 15000 });
    const auto = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return { emotion: line.getAttribute('data-emotion'), intensity: getComputedStyle(line).getPropertyValue('--emo-i').trim() };
    });
    await page.screenshot({ path: path.join(out, 'auto.png'), fullPage: false });
    await page.evaluate(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); });
    await page.waitForFunction(() => {
      const v = document.getElementById('view-settings');
      return v && !v.hidden && getComputedStyle(v).display !== 'none';
    }, null, { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.querySelector('.skset-link[data-skset-key="lyrics"]'); if (b) b.click(); });
    await page.waitForTimeout(150);
    await page.selectOption('#set-emotion-lock', 'anger');
    await page.click('#set-emotion-lock-apply');
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.getAttribute('data-emotion') === 'anger';
    }, null, { timeout: 15000 });
    const lockedHash = await page.evaluate(async () => {
      const lines = Stage.lyrics().lines.map((line, index) => ({
        index, start_ms: line.start_ms, text: line.text.normalize('NFC')
      }));
      return await LyricEmotion.hashLyrics(lines);
    });
    const savedLocks = await fixture.api('/v1/ai/lyrics/emotion/locks?lyricsHash=' +
      encodeURIComponent(lockedHash));
    if (!savedLocks.locks || savedLocks.locks.length !== 1 ||
        savedLocks.locks[0].emotion !== 'anger') {
      throw new Error('手动覆盖未持久化到服务端：' + JSON.stringify(savedLocks));
    }
    await page.click('#set-emotion-lock-clear');
    await page.waitForFunction(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && line.getAttribute('data-emotion') && line.getAttribute('data-emotion') !== 'anger';
    }, null, { timeout: 15000 });
    const clearedLocks = await fixture.api('/v1/ai/lyrics/emotion/locks?lyricsHash=' +
      encodeURIComponent(lockedHash));
    if (clearedLocks.locks && clearedLocks.locks.length) {
      throw new Error('手动覆盖清除后服务端仍有记录：' + JSON.stringify(clearedLocks));
    }
    const accentTarget = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      const words = Array.from(line.querySelectorAll('.word'));
      const target = words.find((word) => word.textContent.trim()) || null;
      return target ? target.textContent.trim() : null;
    });
    if (!accentTarget) throw new Error('侧栏没有可标记的重音词');
    await page.check('#set-emotion-accent');
    await page.fill('#set-emotion-accent-words', accentTarget);
    await page.press('#set-emotion-accent-words', 'Tab');
    await page.waitForFunction((needle) => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      return line && Array.from(line.querySelectorAll('.word[data-emo-accent="true"]'))
        .some((word) => word.textContent.indexOf(needle) >= 0);
    }, accentTarget, { timeout: 10000 });
    const accent = await page.evaluate(() => {
      const line = document.querySelector('.stage-lyrics .lyric.active');
      const words = Array.from(line.querySelectorAll('.word'));
      const marked = words.find((word) => word.hasAttribute('data-emo-accent'));
      const plain = words.find((word) => !word.hasAttribute('data-emo-accent'));
      return {
        marked: !!marked,
        markedWeight: marked ? getComputedStyle(marked).fontWeight : null,
        plainWeight: plain ? getComputedStyle(plain).fontWeight : null
      };
    });
    if (!accent.marked || !accent.plainWeight ||
        !(parseFloat(accent.markedWeight) > parseFloat(accent.plainWeight))) {
      throw new Error('侧栏重音词未生效：' + JSON.stringify(accent));
    }
    await page.uncheck('#set-emotion-accent');
    await page.fill('#set-emotion-accent-words', '');
    await page.press('#set-emotion-accent-words', 'Tab');
    await page.selectOption('#set-emotion-mode', 'off');
    await page.uncheck('#set-emotion-ai-authorized');
    await page.evaluate(() => { const b = document.querySelector('.skset-modal-close'); if (b) b.click(); });
    await page.waitForTimeout(200);

    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      hash: prepared.hash,
      line: prepared.index,
      snapshots,
      cleared,
      pageErrors: errors
    }, null, 2));

    console.log('✓ 侧栏 P0/P1/P2b/P3：手动/classic 场、fixture auto、手动锁定覆盖 auto、清除与默认关闭');
    console.log('  hash ' + prepared.hash + ' line ' + prepared.index + ' words ' + snapshots.joy.words);
    console.log('  weight ' + [snapshots.joy.fontWeight, snapshots.sorrow.fontWeight, snapshots.anger.fontWeight].join('/') +
      '  spacing ' + [snapshots.joy.letterSpacing, snapshots.sorrow.letterSpacing, snapshots.anger.letterSpacing].join('/'));
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
