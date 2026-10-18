// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形引擎 G4 检查：LyricEmotion 的 Cue 契约 + DOM/GL 场一致性。
//
//   PLAYWRIGHT_MODULE=<path> node scripts/check-glyph-g4.js
//
// Node 部分不依赖浏览器：校验摘要、Cue 拒绝策略、强度公式与 33 点 LUT 误差。
// 浏览器部分：真实 StanzaGlyph 消费 LyricEmotion，DOM 写 --emo-dy；
// 逐情绪截图并对比 DOM 位移与 DOM/GL 共用的 B(u)。
//
// 产物：output/glyph-g4/overview.png、g4-<id>.png、report.json。
// 缺 Playwright 时退出码 2（Node 部分仍会先跑完）。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const PAGE = path.join(root, 'plugin', 'ui', 'glyph-g4.html');
const OUT = path.join(root, 'output', 'glyph-g4');
const EM = require('../plugin/ui/lyric-emotion.js');
const F = require('../plugin/ui/lyric-emotion-field.js');

const TOKENS = [
  { text: '他', start_ms: 0, end_ms: 700 },
  { text: '跑', start_ms: 700, end_ms: 1400 },
  { text: '过', start_ms: 1400, end_ms: 2200 },
  { text: '整', start_ms: 2200, end_ms: 3100 },
  { text: '个', start_ms: 3100, end_ms: 3900 },
  { text: '夏', start_ms: 3900, end_ms: 5000 },
  { text: '天', start_ms: 5000, end_ms: 6000 }
];
const LINE = { start_ms: 0, end_ms: 6000, text: '他跑过整个夏天' };
const DOC = { lines: [LINE] };
const EM_PX = 72;
const EMOTIONS = ['joy', 'sorrow', 'anger', 'anxious', 'tender'];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function close(a, b, eps) {
  return Math.abs(a - b) <= eps;
}
function expectedHash() {
  const canonical = JSON.stringify([1, [[LINE.start_ms, LINE.text.normalize('NFC')]]]);
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
function cueDoc(hash, emotion, extra) {
  return Object.assign({
    version: 1, lyricsHash: hash, source: 'fixture',
    lines: emotion === 'neutral' ? [] : [
      { index: 0, emotion, intensity: 1, confidence: 1 }
    ]
  }, extra || {});
}
function lutAt(sample, u) {
  const x = Math.max(0, Math.min(1, u)) * 32;
  const i = Math.min(Math.floor(x), 31);
  const t = x - i;
  return sample.b[i] * (1 - t) + sample.b[i + 1] * t;
}
function rejects(fn, label, failures) {
  try {
    fn();
    failures.push(label + '：未拒绝');
  } catch (err) {
    // expected
  }
}

(async function nodePart() {
  const failures = [];
  const bound = await EM.bindLyrics(DOC);
  const hash = bound.hash;
  assert(hash === expectedHash(), '摘要与 Node crypto 不一致：' + hash + ' vs ' + expectedHash());
  assert(bound.generation === 1 && bound.stale === false, 'generation/hash 绑定异常');

  const rows = {};
  for (const id of EMOTIONS) {
    assert(EM.setCueDoc(cueDoc(hash, id)) === true, 'setCueDoc 失败：' + id);
    assert(EM.commitAtBoundary() === true, 'commitAtBoundary 失败：' + id);
    const state = EM.resolveForLine(0, {});
    assert(state.id === id, id + ' 解析成 ' + state.id);
    assert(close(state.intensity, 1, 1e-9), id + ' 强度应为 1，实际 ' + state.intensity);
    const sample = F.sample(state.profile, state.intensity, EM_PX, 0.35, 0);
    let worst = 0;
    for (let i = 0; i <= 100; i += 1) {
      const u = i / 100;
      const expected = F.evaluate(state.profile, u, state.intensity, EM_PX, 0.35, 0).b;
      worst = Math.max(worst, Math.abs(lutAt(sample, u) - expected));
    }
    assert(worst < 0.02 * EM_PX, id + ' LUT 误差 ' + worst + 'px 超过 0.02em');
    rows[id] = {
      intensity: state.intensity,
      b0: F.evaluate(state.profile, 0, state.intensity, EM_PX, 0.35, 0).b,
      b1: F.evaluate(state.profile, 1, state.intensity, EM_PX, 0.35, 0).b,
      lutWorstPx: Math.round(worst * 1e4) / 1e4
    };
  }

  // 中性 / 低强度 / 段落回退 / 显式 neutral
  assert(EM.setCueDoc(cueDoc(hash, 'neutral')) && EM.commitAtBoundary(), 'neutral Cue 失败');
  assert(EM.resolveForLine(0).id === 'neutral', '空 Cue 应回中性');

  assert(EM.setCueDoc({
    version: 1, lyricsHash: hash, source: 'fixture',
    sections: [{ from: 0, to: 0, emotion: 'sorrow', intensity: 0.8, confidence: 0.9 }]
  }) && EM.commitAtBoundary(), 'section Cue 失败');
  const section = EM.resolveForLine(0, {});
  assert(section.id === 'sorrow', 'section 未命中');
  assert(close(section.intensity, 0.8 * 0.8 * (0.4 + 0.6 * 0.9), 1e-9), 'section 强度未乘 0.8');

  assert(EM.setCueDoc({
    version: 1, lyricsHash: hash, source: 'fixture',
    lines: [{ index: 0, emotion: 'neutral', intensity: 1, confidence: 0.9 }]
  }) && EM.commitAtBoundary(), '显式 neutral 失败');
  assert(EM.resolveForLine(0).id === 'neutral', '显式 neutral 被段落覆盖');

  rejects(() => EM.setCueDoc(cueDoc('sha256:' + '0'.repeat(64), 'joy')), '错 hash', failures);
  rejects(() => EM.setCueDoc(cueDoc(hash, 'unknown')), '未知情绪', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, lines: [
      { index: 0, emotion: 'joy', intensity: 1, confidence: 1 },
      { index: 0, emotion: 'sorrow', intensity: 1, confidence: 1 }
    ]
  }), '重复行号', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, lines: [{ index: 1, emotion: 'joy', intensity: 1, confidence: 1 }]
  }), '行号越界', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, lines: [{ index: 0, emotion: 'joy', intensity: '1', confidence: 1 }]
  }), '字符串强度', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, lines: [{ index: 0, emotion: 'joy', intensity: 1, confidence: Infinity }]
  }), '非有限置信度', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, lines: [{ index: 0, emotion: 'joy', intensity: 1, confidence: 1, css: 'x' }]
  }), '未登记字段', failures);
  rejects(() => EM.setCueDoc({
    version: 1, lyricsHash: hash, sections: [
      { from: 0, to: 0, emotion: 'joy', intensity: 1, confidence: 1 },
      { from: 0, to: 0, emotion: 'sorrow', intensity: 1, confidence: 1 }
    ]
  }), '重叠 section', failures);
  if (failures.length) throw new Error('Node 失败：' + failures.join('；'));

  return { hash, rows, failures };
})().then(async (nodeResult) => {
  let chromium;
  try {
    ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
  } catch (err) {
    console.log('Node 部分通过（hash ' + nodeResult.hash.slice(0, 15) + '…）');
    console.log('SKIP 未安装 Playwright（' + (err.message || '').split('\n')[0] + '）');
    process.exit(2);
  }
  if (!fs.existsSync(PAGE)) {
    console.error('✗ 缺少检查页 ' + path.relative(root, PAGE));
    process.exit(1);
  }

  let browser = null;
  try {
    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      headless: process.env.GLYPH_HEADED !== '1',
      args: ['--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForFunction(() => window.__glyphG4 && window.__glyphG4.ready, null, { timeout: 60000 });
    const boot = await page.evaluate(() => window.__glyphG4.verdict);
    assert(boot === 'PASS', '页面未通过：' + JSON.stringify(boot));

    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'overview.png'), fullPage: true });

    const shots = {};
    const states = {};
    const ids = ['neutral'].concat(EMOTIONS);
    for (const id of ids) {
      const snap = await page.evaluate((name) => window.__glyphG4.select(name), id);
      states[id] = snap;
      assert(snap.emotion === id, id + ' 选择未生效');
      assert(snap.state && snap.state.id === id, id + ' 状态为 ' + (snap.state && snap.state.id));
      if (id !== 'neutral') {
        assert(snap.state.intensity > 0, id + ' 强度为 0');
      }
      snap.dom.forEach((row) => {
        assert(close(row.dy, row.expected, 1e-3), id + ' DOM --emo-dy ' + row.dy + ' != B ' + row.expected);
        assert(close(row.ty, row.expected, 1e-3), id + ' DOM transform ' + row.ty + ' != B ' + row.expected);
      });
      const stage = page.locator('#g4-glyph-stage');
      const dom = page.locator('#g4-dom');
      const glyphFile = path.join(OUT, 'g4-' + id + '.png');
      const domFile = path.join(OUT, 'g4-' + id + '-dom.png');
      await stage.screenshot({ path: glyphFile });
      await dom.screenshot({ path: domFile });
      shots[id] = { glyph: glyphFile, dom: domFile };
    }

    function bytes(file) { return fs.readFileSync(file); }
    const neutralBytes = bytes(shots.neutral.glyph);
    const joyBytes = bytes(shots.joy.glyph);
    const sorrowBytes = bytes(shots.sorrow.glyph);
    assert(!neutralBytes.equals(joyBytes), 'neutral 与 joy 的 GL 画面相同，情绪未进入渲染器');
    assert(!joyBytes.equals(sorrowBytes), 'joy 与 sorrow 的 GL 画面相同，场未生效');

    const report = {
      generatedAt: new Date().toISOString(),
      page: path.relative(root, PAGE),
      node: nodeResult,
      browser: {
        states,
        glyphChanged: {
          neutralVsJoy: !neutralBytes.equals(joyBytes),
          joyVsSorrow: !joyBytes.equals(sorrowBytes)
        },
        screenshots: Object.keys(shots).map((id) => ({
          id,
          glyph: path.relative(root, shots[id].glyph),
          dom: path.relative(root, shots[id].dom)
        })),
        pageErrors,
        consoleErrors
      }
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    console.log('\nG4 · LyricEmotion × 字形引擎');
    console.log('  摘要 ' + nodeResult.hash);
    for (const id of EMOTIONS) {
      const row = nodeResult.rows[id];
      console.log(`  ${id.padEnd(8)} B(0)=${row.b0.toFixed(2)}px B(1)=${row.b1.toFixed(2)}px LUT ${row.lutWorstPx}px`);
    }
    console.log(`  DOM/GL 状态：${ids.length} 档通过；GL 画面 neutral≠joy、joy≠sorrow`);
    if (pageErrors.length) console.log('  页面异常: ' + pageErrors.join('；'));
    if (consoleErrors.length) console.log('  console errors: ' + consoleErrors.join('；'));
    console.log('\n  证据: ' + path.relative(root, OUT));

    if (pageErrors.length || consoleErrors.length) {
      console.error('✗ G4 未通过');
      process.exit(1);
    }
    console.log('✓ G4 通过');
    process.exit(0);
  } catch (err) {
    console.error('✗ ' + (err && err.message || err));
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}).catch((err) => {
  console.error('✗ ' + (err && err.message || err));
  process.exit(1);
});
