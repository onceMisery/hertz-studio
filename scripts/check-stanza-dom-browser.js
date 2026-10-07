// SPDX-License-Identifier: MIT
// Real DOM/canvas checks for classic/cadenza media-clock behavior.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const stanza = path.resolve(__dirname, '../plugin/ui/stanza');

async function boot(browser, mode, viewport) {
  const page = await browser.newPage({ viewport });
  await page.setContent('<style>html,body,#host{margin:0;position:absolute;inset:0}body{background:#09090b;color:white}</style><div id="host"></div>');
  await page.addStyleTag({ path: path.join(stanza, 'stanza.css') });
  for (const name of ['stanza-util.js', 'stanza-theme.js', 'stanza-textlayout.js', 'stanza-sonnet-fx.js',
    'stanza-classic.js', 'stanza-cadenza.js']) await page.addScriptTag({ path: path.join(stanza, name) });
  await page.evaluate(mode => {
    const p = window.probe = { time: 800, playing: true, audio: 0.4, mode, writes: 0, clears: 0 };
    function line(text, start) {
      return { text, start_ms: start, end_ms: start + 4000,
        words: Array.from(text).map((text, i) => ({ text, start_ms: start + i * 1000, end_ms: start + (i + 1) * 1000 })) };
    }
    p.lines = [line('风吹过来', 0), line('晚霞渐远', 4000)];
    window.Stage = { position: () => p.time, lyrics: () => ({ lines: p.lines }), lyricTokens: line => line.words,
      presentation: () => ({ playing: p.playing, track: { path: 'dom-clock-probe' } }),
      energy: () => p.audio, spectrum: () => new Array(64).fill(p.audio) };
    p.host = document.querySelector('#host');
    p.make = () => {
      p.renderer = mode === 'classic' ? StanzaClassic.init(p.host) : StanzaCadenza.init(p.host);
      p.renderer.setPaused(!p.playing);
      if (mode === 'cadenza') {
        const ctx = p.renderer.rootEl().querySelector('canvas').getContext('2d');
        const clear = ctx.clearRect;
        ctx.clearRect = function (...args) { p.clears++; return clear.apply(this, args); };
      }
    };
    p.make();
    p.sample = time => { p.time = time; p.renderer.frame(16); };
    p.pose = () => Array.from(p.host.querySelectorAll(mode === 'classic' ? '.fl-cword' : '.fl-cadz'))
      .map(node => ({ text: node.textContent, transform: node.style.transform, opacity: node.style.opacity,
        glow: node.querySelector('.fl-glow').style.textShadow }));
    p.animations = () => p.renderer.rootEl().getAnimations({ subtree: true })
      .map(a => ({ name: a.animationName, state: a.playState, time: a.currentTime }));
    p.observer = new MutationObserver(records => { p.writes += records.length; });
    p.observer.observe(p.host, { attributes: true, subtree: true, childList: true });
    p.sample(800);
  }, mode);
  return page;
}

async function run(browser, mode, viewport) {
  const page = await boot(browser, mode, viewport);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    const before = await page.evaluate(() => {
      const p = probe;
      p.playing = false; p.renderer.setPaused(true);
      return { pose: p.pose(), bass: p.renderer.rootEl().style.getPropertyValue('--fl-bass') };
    });
    await page.waitForTimeout(40); // Allow WAAPI's pending pause to settle.
    const frozen = await page.evaluate(() => { probe.writes = 0; probe.clears = 0; return probe.animations(); });
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => {
      const p = probe; p.audio = 1;
      for (let i = 0; i < 40; i++) p.renderer.frame(16);
      return { pose: p.pose(), bass: p.renderer.rootEl().style.getPropertyValue('--fl-bass'), animations: p.animations(), clears: p.clears };
    });
    assert.deepEqual(after.pose, before.pose, mode + ': pause freezes node poses');
    if (mode === 'classic') {
      assert.equal(after.bass, before.bass, 'classic: pause freezes audio scale');
      assert.ok(frozen.some(a => a.name === 'fl-glow-n'), 'classic: fixture exercises real glyph glow');
      assert.ok(frozen.every(a => a.state === 'paused' || a.state === 'finished'), 'classic: child CSS animations pause');
      assert.deepEqual(after.animations, frozen, 'classic: paused animation times stay fixed');
      const resumed = await page.evaluate(() => { probe.playing = true; probe.renderer.setPaused(false); return probe.animations(); });
      assert.ok(resumed.some(a => a.name === 'fl-glow-n' && a.state === 'running'), 'classic: glyph glow resumes');
      const outgoing = await page.evaluate(() => {
        for (let time = 820; time <= 4000; time += 20) probe.sample(time);
        probe.playing = false; probe.renderer.setPaused(true);
        return probe.host.querySelectorAll('.fl-cline').length;
      });
      assert.equal(outgoing, 2, 'classic: genuine line boundary has one outgoing and one incoming line');
      await page.waitForTimeout(380);
      assert.equal(await page.evaluate(() => { probe.renderer.frame(16); return probe.host.querySelectorAll('.fl-cline').length; }),
        2, 'classic: paused outgoing line survives beyond the old wall-clock timeout');
      const retired = await page.evaluate(() => {
        probe.playing = true; probe.renderer.setPaused(false); probe.sample(4340);
        return probe.host.querySelectorAll('.fl-cline').length;
      });
      assert.equal(retired, 1, 'classic: outgoing line retires when media time advances');
      const sought = await page.evaluate(() => { probe.sample(800); return { lines: probe.host.querySelectorAll('.fl-cline').length,
        outgoing: probe.host.querySelectorAll('[class*="fl-exit-"]').length }; });
      assert.deepEqual(sought, { lines: 1, outgoing: 0 }, 'classic: seek removes obsolete outgoing lyrics');
      const prelude = await page.evaluate(() => {
        probe.lines = [{ text: '前奏后的词', start_ms: 3000, end_ms: 7000, words: [] }];
        probe.sample(0);
        return { lines: probe.host.querySelectorAll('.fl-cline').length, empty: probe.host.querySelectorAll('.fl-empty').length };
      });
      assert.deepEqual(prelude, { lines: 0, empty: 1 }, 'classic: seek into a prelude cannot leave the previous line behind');
    } else {
      assert.equal(after.clears, 0, 'cadenza: frozen frames do not clear/redraw the canvas');
      assert.equal(await page.evaluate(() => probe.writes), 0, 'cadenza: frozen frames do not rewrite DOM styles');
      const seek = await page.evaluate(() => { probe.sample(2200); return probe.pose(); });
      const fresh = await page.evaluate(() => { probe.renderer.destroy(); probe.make(); probe.sample(2200); return probe.pose(); });
      assert.deepEqual(seek, fresh, 'cadenza: paused seek equals a fresh frame at the same position');
      await page.evaluate(() => { probe.renderer.setTuning({ width: 0.65, glow: 0 }); probe.renderer.frame(16); });
      assert.ok((await page.evaluate(() => probe.pose())).every(n => n.glow === 'none'), 'cadenza: tuning still applies while paused');
      const playingSeek = await page.evaluate(() => {
        probe.playing = true; probe.renderer.setPaused(false); probe.sample(2216); probe.sample(800); return probe.pose();
      });
      const seekTarget = await page.evaluate(() => {
        probe.renderer.destroy(); probe.playing = false; probe.make();
        probe.renderer.setTuning({ width: 0.65, glow: 0 }); probe.sample(800); return probe.pose();
      });
      assert.deepEqual(playingSeek, seekTarget, 'cadenza: backward seek snaps instead of interpolating from the old glyph');
      await page.evaluate(() => { probe.renderer.setFontScale(1.25); probe.renderer.frame(16); });
      assert.notDeepEqual(await page.evaluate(() => probe.pose()), seekTarget, 'cadenza: paused font resize repacks immediately');
    }
    await page.evaluate(() => { probe.renderer.destroy(); probe.observer.disconnect(); });
    assert.equal(await page.evaluate(() => probe.host.children.length), 0, mode + ': destroy releases owned DOM');
    assert.deepEqual(errors, [], mode + ': no browser exceptions');
    console.log('PASS ' + mode + ' ' + viewport.width + 'x' + viewport.height + ': pause, clock discontinuities, retirement and cleanup');
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--disable-gpu'] });
  try {
    for (const viewport of [{ width: 960, height: 640 }, { width: 390, height: 844 }])
      for (const mode of ['classic', 'cadenza']) await run(browser, mode, viewport);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
