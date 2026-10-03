'use strict';
// Real Pixi playback/seek checks. Uses the production renderers with an isolated lyric clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.join(__dirname, '../plugin/ui');
const output = path.join(__dirname, '../output/stanza-motion-verify');

async function boot(page, mode) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    :root{--music-highlight:#90bce8;--music-highlight-rgb:144,188,232}
    html,body{margin:0;width:100%;height:100%;background:#10111e;overflow:hidden}
    #host,.fl-sonnet,.fl-tempera{position:absolute;inset:0}
    canvas{position:absolute;inset:0;width:100%;height:100%}
    .fl-sonnet-eyebrow,.fl-sonnet-hud,.fl-sonnet-hotspot,.fl-tempera-eyebrow,.fl-tempera-note,.fl-tempera-hotspot{display:none}
    </style><div id="host"></div>`);
  for (const file of ['vendor/pixi.min.js', 'stanza/stanza-util.js', 'stanza/stanza-theme.js',
    'stanza/stanza-sonnet-fx.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js']) {
    await page.addScriptTag({ path: path.join(web, file) });
  }
  await page.evaluate(stageMode => {
    const fixture = window.fixture = { time: 0, playing: true, reduced: false, nodes: [] };
    fixture.track = { id: 'motion-fixture', title: '晚风与回声', path: 'motion-fixture' };
    fixture.lines = [
      { start_ms: 0, end_ms: 3000, text: '晚风轻轻吹过' },
      { start_ms: 3000, end_ms: 6000, text: '星光落在你我之间' },
      { start_ms: 6000, end_ms: 6120, text: '听' },
      { start_ms: 6120, end_ms: 6300, text: '见' },
      { start_ms: 6300, end_ms: 11000, text: '让每一颗星都拥有自己的颜色，让每一个梦都可以慢慢发亮' },
      { start_ms: 11000, end_ms: 15000, text: 'Hello 世界，听见 wind & light' }
    ];
    window.Stage = {
      presentation: () => ({ playing: fixture.playing, reduced: fixture.reduced, track: fixture.track }),
      position: () => fixture.time,
      lyrics: () => ({ lines: fixture.lines }),
      lyricTokens: line => [{ text: line.text, start_ms: line.start_ms, end_ms: line.end_ms }],
      spectrum: () => [], kick() {}
    };
    const animate = StanzaSonnetFx.animateLyrics;
    const build = StanzaSonnetFx.buildLyrics;
    StanzaSonnetFx.buildLyrics = (...args) => {
      fixture.textContainer = args[1];
      return build(...args);
    };
    StanzaSonnetFx.animateLyrics = (nodes, frame, tuning, color) => {
      animate(nodes, frame, tuning, color);
      fixture.nodes = nodes;
    };
    fixture.renderer = (stageMode === 'sonnet' ? StanzaSonnet : StanzaTempera).init(document.getElementById('host'));
    fixture.renderer.setTheme(StanzaTheme.resolveSonnet(1));
    fixture.renderer.setVisible(true);
    fixture.sample = time => {
      fixture.time = time;
      fixture.renderer.frame();
      const inversion = stageMode === 'tempera' && fixture.textContainer.parent.children.find(c => c.mask);
      return { debug: fixture.renderer.getDebugSnapshot(), clones: inversion ? inversion.children.map(n => n.alpha) : [],
        nodes: fixture.nodes.map(n => ({
        text: n.text, x: n.x, y: n.y, alpha: n.alpha, tint: n.tint,
        sx: n.scale.x, sy: n.scale.y, rotation: n.rotation,
        baseX: n.dataset.baseX, baseY: n.dataset.baseY, fit: n.dataset.fit,
        bounds: (() => { const b = n.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()
      })) };
    };
  }, mode);
  await page.waitForFunction(() => fixture.renderer.getDebugSnapshot().initialized);
}

async function run(browser, mode, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/shader.*error|GL_INVALID|failed to compile/i.test(message.text())) errors.push(message.text()); });
  const prefix = `${mode}-${viewport.width}x${viewport.height}`;
  try {
    await boot(page, mode);
    const sample = t => page.evaluate(time => fixture.sample(time), t);
    const singing = await sample(1000);
    if (mode === 'tempera') assert.deepEqual(singing.clones, singing.nodes.map(n => n.alpha), prefix + ': inversion tracks glyph opacity');
    await page.screenshot({ path: path.join(output, prefix + '-singing.png') });
    const stable = await sample(2150);
    await page.evaluate(() => { fixture.playing = false; });
    const paused = await sample(2150);
    assert.deepEqual(paused.nodes, stable.nodes, prefix + ': pause freezes typography');
    await sample(100);
    const seek = await sample(2150);
    assert.deepEqual(seek.nodes, stable.nodes, prefix + ': seek reproduces typography');
    await page.evaluate(() => { fixture.playing = true; });
    await sample(2990);
    const boundary = await sample(3000);
    assert.ok(boundary.debug.retirement.outgoingGlyphs > 0, prefix + ': outgoing lyrics survive line handoff');
    await sample(3060);
    await page.screenshot({ path: path.join(output, prefix + '-handoff.png') });
    const settled = await sample(3280);
    assert.equal(settled.debug.retirement.outgoingGlyphs, 0, prefix + ': old lyrics retire within 240ms');
    await sample(5990); await sample(6000); await sample(6110); await sample(6120);
    await sample(6290); await sample(6300);
    const long = await sample(7300);
    assert.equal(long.nodes.map(n => n.text).join(''), '让每一颗星都拥有自己的颜色，让每一个梦都可以慢慢发亮');
    for (const node of long.nodes) {
      assert.ok(node.bounds.x >= 0 && node.bounds.y >= 0
        && node.bounds.x + node.bounds.width <= viewport.width
        && node.bounds.y + node.bounds.height <= viewport.height, prefix + ': long lyric stays inside viewport: ' + node.text);
    }
    await page.screenshot({ path: path.join(output, prefix + '-long.png') });
    await sample(11200);
    await page.screenshot({ path: path.join(output, prefix + '-mixed.png') });
    await page.evaluate(() => { fixture.reduced = true; });
    const reduced = await sample(3500);
    reduced.nodes.forEach(n => assert.deepEqual([n.x, n.y, n.sx, n.sy, n.rotation],
      [n.baseX, n.baseY, n.fit, n.fit, 0], prefix + ': reduced motion keeps base pose'));
    assert.equal(reduced.debug.retirement.outgoingGlyphs, 0);
    const later = await sample(4500);
    assert.notDeepEqual(later.nodes.map(n => n.tint), reduced.nodes.map(n => n.tint), prefix + ': reduced motion still highlights lyrics');
    await page.screenshot({ path: path.join(output, prefix + '-reduced.png') });
    await page.evaluate(() => { fixture.reduced = false; fixture.renderer.setEco(true); });
    await sample(2990);
    const eco = await sample(3000);
    assert.equal(eco.debug.retirement.outgoingGlyphs, 0, prefix + ': eco has no outgoing allocation');
    await page.evaluate(() => { fixture.renderer.setEco(false); });
    await sample(2990); await sample(3000);
    const jump = await sample(9000);
    assert.equal(jump.debug.retirement.outgoingGlyphs, 0, prefix + ': seek clears outgoing lyrics');
    assert.deepEqual(errors, [], prefix + ': no runtime or shader errors');
    await page.evaluate(() => fixture.renderer.destroy());
    assert.equal(await page.locator('canvas').count(), 0, prefix + ': renderer releases canvas');
    console.log('PASS ' + prefix + ': playback, pause, seek, handoff, short/long/mixed lines, reduced motion, eco and destroy');
  } finally {
    await page.close();
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const mode of ['sonnet', 'tempera']) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await run(browser, mode, viewport);
      }
    }
  } finally {
    await browser.close();
  }
  console.log('Screenshots: ' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
