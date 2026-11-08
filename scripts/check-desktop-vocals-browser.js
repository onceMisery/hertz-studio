// SPDX-License-Identifier: MIT
// Bounded A10 renderer regressions. Own browser only; no player/config/process mutation.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { config: ordinaryConfig } = require('./check-desktop-lyrics-browser');
const root = path.resolve(__dirname, '..'), assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/desktop-vocals');
const agents = [
  { id: 'a', kind: 'person', name: '同名演唱者' },
  { id: 'b', kind: 'person', name: '同名演唱者' },
  { id: 'c', kind: 'group', name: '一个很长的来源作者姓名与联合演唱标注' },
  { id: 'd', kind: 'other' },
];
const line = (index, changes = {}) => ({ startMs: 1000, endMs: 6000, text: '正文' + index,
  translation: '译文' + index, romanization: 'Romanization ' + index,
  vocal: { agentIds: [agents[index % agents.length].id], role: 'lead' }, words: [], ...changes });
const doc = (key, lines) => ({ protocol: 1, timing: 'presentation_applied', documentKey: key, vocalSchemaVersion: 1, agents, lines });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${fs.readFileSync(path.join(assets, 'desktop-lyrics.css'), 'utf8')}</style><body>
${fs.readFileSync(path.join(assets, 'desktop-lyrics.html'), 'utf8')}
<script>window.commands=[];window.ipc={postMessage:text=>commands.push(JSON.parse(text))};</script>
<script>${fs.readFileSync(path.join(assets, 'desktop-lyrics.js'), 'utf8')}</script></body></html>`;

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 550, height: 470 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    await page.setContent(html);
    await page.evaluate(() => { document.documentElement.style.background = '#24262b'; });
    await page.evaluate(config => {
      window.f = { config: { ...config, showVocals: true, layout: 'triple', bilingual: true }, capacity: 4, seq: 0, generation: 1 };
      f.geometryValue = function () {
        const c = f.config;
        return { documentKey: f.document.documentKey, capacity: c.showVocals ? f.capacity : c.bilingual ? 2 : 1,
          slotHeight: Math.ceil(2 * 1.32 * c.fontSize + 8), showVocals: c.showVocals, bilingual: c.bilingual,
          fontKey: [c.fontFamily, c.fontSize, c.fontWeight, c.outlineWidth].join('|') };
      };
      f.geometry = function () { hertzLyrics.applyGeometry(f.geometryValue()); };
      f.send = function (position = f.position, changes = {}) {
        f.position = position;
        f.snapshot = { protocol: 1, seq: ++f.seq, server: { session: 'vocal-session' }, generation: String(f.generation),
          positionMs: position, durationMs: 100000, playing: false, buffering: false, track: { id: 'vocal-track' },
          lyrics: { status: 'ready', documentKey: f.document.documentKey }, ...changes };
        hertzLyrics.applySnapshot(structuredClone(f.snapshot));
      };
      f.load = function (document, position = 2000) {
        f.document = structuredClone(document); f.generation++; f.send(position); f.geometry(); hertzLyrics.applyDocument(f.document);
      };
      f.configure = function (changes, capacity = f.capacity) {
        f.config = { ...f.config, ...changes }; f.capacity = capacity;
        hertzLyrics.applyConfig({ ...f.config, vocalGeometry: f.geometryValue() });
      };
      hertzLyrics.applyConfig(f.config); hertzLyrics.setSource({ state: 'ok' });
    }, ordinaryConfig);
    const load = (document, position) => page.evaluate(({ document, position }) => f.load(document, position), { document, position });
    const seek = position => page.evaluate(position => { f.generation++; f.send(position); }, position);
    const configure = (changes, capacity) => page.evaluate(({ changes, capacity }) => f.configure(changes, capacity), { changes, capacity });
    const slots = () => page.locator('.vocal-slot').evaluateAll(nodes => nodes.map(n => ({ index: Number(n.dataset.index), kind: n.dataset.kind })));
    const bodies = () => page.locator('.vocal-slot.main > .lyric-text').allTextContents();

    // V01: a short overlap never hides a continuing long interval; exact end is exclusive.
    await load(doc('intervals', [line(0, { startMs: 0, endMs: 4000, text: '持续主唱' }),
      line(1, { startMs: 2500, endMs: 3000, text: '短伴唱', vocal: { agentIds: ['b'], role: 'backing' } }),
      line(2, { startMs: 5000, endMs: 5500, text: '未标注非重叠行', vocal: undefined }),
      line(3, { startMs: 5500, endMs: 5500, text: '零长度' })]), 2500);
    await page.evaluate(() => { window.continuingNode = document.querySelector('.vocal-slot.main'); });
    assert.deepEqual(await bodies(), ['持续主唱', '短伴唱']);
    await seek(3000);
    assert.deepEqual(await bodies(), ['持续主唱']);
    assert.equal(await page.evaluate(() => document.querySelector('.vocal-slot.main') === continuingNode), true, 'Continuing body preserves its node');
    await seek(4000); assert.deepEqual(await bodies(), []); assert.equal(await page.locator('#notice').textContent(), '· · ·');
    await seek(5000); assert.deepEqual(await bodies(), ['未标注非重叠行']);
    await seek(5500); assert.deepEqual(await bodies(), []);
    await configure({ showVocals: false }); await seek(4500); assert.deepEqual(await bodies(), [], 'Single selection still uses true intervals');
    await configure({ showVocals: true });
    console.log('PASS V01 exact overlapping intervals, node reuse, unannotated and zero-length intervals');

    // V08: all bodies consume slots first; translations compete in owner priority and follow owners.
    for (let count = 1; count <= 5; count++) {
      await load(doc('slots-' + count, Array.from({ length: count }, (_, index) => line(index, { vocal: { agentIds: ['a'], role: 'lead' } }))));
      const bodyCount = Math.min(4, count), subtitleCount = Math.min(bodyCount, 4 - bodyCount), expected = [];
      for (let index = 0; index < bodyCount; index++) {
        expected.push({ index, kind: 'body' }); if (index < subtitleCount) expected.push({ index, kind: 'secondary' });
      }
      assert.deepEqual(await slots(), expected);
      assert.equal(await page.locator('#vocal-capacity').textContent(), count === 5 ? '还有1行' : '');
    }
    await configure({}, 2);
    assert.deepEqual(await slots(), [{ index: 0, kind: 'body' }, { index: 1, kind: 'body' }]);
    assert.equal(await page.locator('#vocal-capacity').textContent(), '空间不足 · 还有3行');
    await configure({ showVocals: false });
    assert.deepEqual(await slots(), [{ index: 0, kind: 'body' }, { index: 0, kind: 'secondary' }]);
    assert.equal(await page.locator('#vocal-capacity').isVisible(), false);
    await configure({ showVocals: true }, 4);
    await load(doc('priority', [line(0, { vocal: { agentIds: ['a'], role: 'backing' } }),
      line(1, { vocal: { agentIds: ['d'], role: 'lead' } }), line(2, { vocal: { agentIds: ['b'], role: 'lead' } }),
      line(3, { vocal: { agentIds: ['a'], role: 'lead' } }), line(4, { vocal: { agentIds: ['a', 'c'], role: 'lead' } })]));
    assert.deepEqual(await slots(), [3, 4, 2, 1].map(index => ({ index, kind: 'body' })));
    const labels = await page.locator('.vocal-label').allTextContents();
    assert.deepEqual(labels, ['同名演唱者 (a)', '同名演唱者 (a) / 一个很长的来源作者姓名与联合演唱标注', '同名演唱者 (b)', 'd']);
    assert.deepEqual(await page.locator('.vocal-label').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), labels);
    await page.setViewportSize({ width: 240, height: 914 });
    await configure({ fontSize: 72 });
    assert.equal(await page.locator('.vocal-label').evaluateAll(nodes => nodes.every(n => n.getBoundingClientRect().width <= n.parentElement.clientWidth * .25 + .5)), true);
    assert.equal(await page.locator('.vocal-label').first().evaluate(n => getComputedStyle(n).fontSize), '33.12px');
    await page.screenshot({ path: path.join(output, 'narrow-labels.png') });
    await configure({ fontSize: 30 }, 0);
    assert.equal(await page.locator('.vocal-slot').count(), 0);
    assert.equal(await page.locator('#notice').textContent(), '空间不足，请调整字号或屏幕设置');
    await configure({}, 4); await page.setViewportSize({ width: 550, height: 470 });
    console.log('PASS V08 body-first slots, ordered secondary ownership, capacity, labels and deliberate single selection');

    // V09: paused config/seek paints once; buffers freeze; rejected and stale identities cannot retain words.
    const timed = line(0, { text: '真实词', words: [{ text: '真实', startMs: 1000, endMs: 3000 }, { text: '词', startMs: 3000, endMs: 6000 }] });
    await load(doc('clock', [timed]));
    const initialMask = await page.locator('.word').first().getAttribute('style');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.word').first().getAttribute('style'), initialMask);
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().running), false);
    await configure({ karaoke: false }); assert.equal(await page.locator('.word').count(), 0);
    await configure({ karaoke: true }); await seek(3500);
    assert.equal(await page.locator('.word').first().evaluate(n => n.style.getPropertyValue('--p')), '100.00%');
    await page.evaluate(() => { f.send(3500, { playing: true, buffering: true }); });
    const bufferMask = await page.locator('.word').last().getAttribute('style');
    await page.waitForTimeout(200); assert.equal(await page.locator('.word').last().getAttribute('style'), bufferMask);
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().running), false);
    await page.evaluate(() => { f.send(4500, { playing: true }); f.send(4600, { playing: true }); });
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().running), true);
    await page.evaluate(() => hertzLyrics.setActive(false));
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().running), false);
    await page.evaluate(() => { f.generation++; f.send(1200); hertzLyrics.setActive(true); });
    assert.equal(await page.locator('.word').first().evaluate(n => n.style.getPropertyValue('--p')), '10.00%');
    for (const [status, text] of [['unsupported', '当前桌面歌词组件不支持此歌词，请更新组件'], ['invalid', '歌词内容无效，请在播放器中重新导入']]) {
      await page.evaluate(status => f.send(1200, { lyrics: { status, documentKey: 'clock' } }), status);
      assert.equal(await page.locator('.word').count(), 0);
      assert.equal(await page.locator('#notice').textContent(), text);
      await page.evaluate(() => hertzLyrics.applyDocument(f.document));
      assert.equal(await page.locator('.vocal-slot').count(), 0, 'Late rejected document stays cleared');
      assert.equal(await page.locator('#play').isDisabled(), false, 'Format rejection preserves existing playback control');
    }
    await page.evaluate(() => { hertzLyrics.setSource({ state: 'error', message: '连接已断开' }); hertzLyrics.applyDocument(f.document); });
    assert.equal(await page.locator('.vocal-slot').count(), 0);
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().events), 0);
    await page.evaluate(() => hertzLyrics.setSource({ state: 'ok' }));
    await load(doc('replacement', [timed]));
    await page.evaluate(() => {
      const c = f.config;
      hertzLyrics.applyGeometry({ documentKey: 'clock', capacity: 0, slotHeight: 88, showVocals: c.showVocals,
        bilingual: c.bilingual, fontKey: [c.fontFamily, c.fontSize, c.fontWeight, c.outlineWidth].join('|') });
      f.send(2000);
    });
    assert.equal(await page.locator('.word').count(), 2, 'Late geometry cannot replace the new document capacity');
    await page.evaluate(() => { f.generation++; f.send(2000, { snapshotAgeMs: 2100 }); });
    assert.equal(await page.locator('.word').count(), 0);
    await page.evaluate(() => { f.geometry(); f.send(2000); hertzLyrics.applyDocument(f.document); });
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('.word').count(), 0);
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().words), 0);
    console.log('PASS V09 paused config/seek, buffering, hide/restore, rejection, source and stale cleanup');

    // V13: 64 real word units per body, 256 total, 800 content elements; 65 degrades the whole line.
    const dense = (index, count) => line(index, { text: '词'.repeat(count), vocal: { agentIds: ['a'], role: 'lead' },
      words: Array.from({ length: count }, (_, word) => ({ text: '词', startMs: 1000 + word * 50, endMs: 1050 + word * 50 })) });
    await load(doc('dense', Array.from({ length: 4 }, (_, index) => dense(index, 64))));
    assert.equal(await page.locator('.word').count(), 256);
    assert.equal(await page.locator('.word span').count(), 512);
    assert.equal(await page.locator('#stage *').count() <= 800, true);
    await load(doc('degraded', [dense(0, 65)]));
    assert.equal(await page.locator('.word').count(), 0);
    assert.deepEqual(await bodies(), ['词'.repeat(65)], 'Whole real line survives degradation');
    await load(doc('linear', Array.from({ length: 2048 }, (_, index) => line(index, {
      startMs: index * 100, endMs: index * 100 + 100, text: '有界' + index, translation: undefined,
      vocal: { agentIds: ['a'], role: index % 2 ? 'backing' : 'lead' } }))), 2000);
    assert.equal(await page.evaluate(() => hertzLyrics.diagnostics().events), 4096);
    for (let loop = 0; loop < 100; loop++) {
      await page.evaluate(loop => { f.generation++; f.send((loop * 1733) % 100000); f.configure({ karaoke: loop % 2 === 0, bilingual: loop % 3 === 0 }); }, loop);
      assert.equal(await page.locator('.vocal-slot').count() <= 4, true);
      assert.equal(await page.locator('#stage *').count() <= 800, true);
    }
    await page.evaluate(() => hertzLyrics.setSource({ state: 'error' }));
    assert.deepEqual(await page.evaluate(() => hertzLyrics.diagnostics()), {
      vocalMode: false, events: 0, cursor: 0, slots: 0, words: 0, running: false, documentKey: null });
    assert.deepEqual(errors, []);
    console.log('PASS V13 64/65-word degradation, 256-word/800-element budget, linear 2N index and 100 seek/config cleanup loops');
    console.log('Desktop vocals browser checks passed. Evidence: ' + output);
  } finally { await browser.close(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { agents, line, doc };
