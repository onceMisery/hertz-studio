// SPDX-License-Identifier: MIT
// Exercise the actual host handoff functions and CSS in Chrome with a controlled media clock.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const source = fs.readFileSync(path.join(ui, 'stage3d.js'), 'utf8');
const host = source.slice(source.indexOf('  var HANDOFF_MAX_MS'), source.indexOf('  // 曲式层读数'));

async function run(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.setContent('<div id="s3d-fl-lyric"><div id="classic">旧歌词</div><div id="cadenza">新歌词</div></div>'
      + '<div id="s3d-fl-sonnet-stage"><div id="sonnet">商籁</div><div id="tempera">凝彩</div></div>');
    await page.addStyleTag({ path: path.join(ui, 'stanza/stanza.css') });
    await page.addScriptTag({ content: `(function () {
      var global=window, showLyrics=true;
      var probe=window.probe={time:1000,playing:true,reduced:false,ready:{classic:true,cadenza:true,sonnet:false,tempera:false}};
      var RENDERER_IDS=['classic','cadenza','sonnet','tempera'], stanza={shownVisual:null};
      function $(id){return document.getElementById(id)}
      function reducedMotion(){return probe.reduced}
      function songformNow(){return {line:{gapBefore:0.6}}}
      function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
      window.Stage={position:()=>probe.time,presentation:()=>({playing:probe.playing})};
      RENDERER_IDS.forEach(id=>stanza[id]={rootEl:()=>$(id),setVisible:b=>$(id).hidden=!b,isReady:()=>probe.ready[id]});
      ${host}
      probe.switchTo=id=>{applyLayerVisibility(id,showLyrics);driveHandoff()};
      probe.frame=time=>{probe.time=time;driveHandoff()};
      probe.show=b=>{showLyrics=b;applyLayerVisibility(stanza.shownVisual,b)};
      probe.state=()=>Object.fromEntries(RENDERER_IDS.map(id=>[id,{
        visible:!$(id).hidden,opacity:Number(getComputedStyle($(id)).opacity),
        filter:getComputedStyle($(id)).filter,classes:$(id).className,
        willChange:getComputedStyle($(id)).willChange
      }]));
      probe.switchTo('classic');
    })();` });
    const state = () => page.evaluate(() => probe.state());
    await page.evaluate(() => probe.switchTo('sonnet'));
    await page.waitForTimeout(520);
    let s = await state();
    assert.equal(s.classic.visible, true, 'cold start keeps the outgoing renderer');
    assert.equal(s.classic.opacity, 1);
    assert.equal(s.sonnet.opacity, 0, 'unready renderer cannot flash');
    await page.evaluate(() => { probe.ready.sonnet=true; probe.frame(1520); probe.frame(1634); });
    s = await state();
    assert.ok(Math.abs(s.classic.opacity - 0.5) < 0.001, 'both layers use the same 228ms duration');
    assert.ok(Math.abs(s.sonnet.opacity - 0.5) < 0.001);
    assert.equal(s.classic.filter, 'none', 'crossfade has no full-layer blur');
    await page.evaluate(() => { probe.playing=false; });
    await page.waitForTimeout(520);
    await page.evaluate(() => { for(let i=0;i<40;i++) probe.frame(1634); });
    assert.deepEqual(await state(), s, 'paused crossfade survives wall time without changes');
    await page.evaluate(() => { probe.playing=true; probe.frame(1748); });
    s = await state();
    assert.equal(s.classic.visible, false, 'old layer is released on the playback deadline');
    assert.equal(s.sonnet.opacity, 1);
    assert.ok(Object.values(s).every(v=>!v.classes && v.willChange==='auto'), 'compositing hints cleaned');

    await page.evaluate(() => { probe.switchTo('cadenza'); probe.frame(1800); probe.frame(500); });
    s = await state();
    assert.equal(s.sonnet.visible, false, 'backward seek clears outgoing scene');
    assert.equal(s.cadenza.opacity, 1);
    await page.evaluate(() => { probe.playing=false; probe.switchTo('classic'); });
    s = await state();
    assert.equal(s.classic.opacity, 1, 'manual paused selection is usable immediately');
    assert.equal(s.cadenza.visible, false);
    await page.evaluate(() => { probe.playing=true; probe.reduced=true; probe.switchTo('sonnet'); });
    s = await state();
    assert.equal(s.sonnet.opacity, 1, 'reduced motion avoids crossfade');
    assert.equal(s.classic.visible, false);

    await page.evaluate(() => {
      probe.reduced=false; probe.switchTo('classic'); probe.frame(1000);
      probe.ready.sonnet=false; probe.switchTo('sonnet'); probe.switchTo('tempera');
    });
    s = await state();
    assert.equal(s.classic.visible, true, 'rapid cold selections retain the last ready scene');
    assert.equal(s.classic.opacity, 1);
    assert.equal(s.sonnet.visible, false, 'intermediate cold scene retires');
    await page.evaluate(() => probe.show(false));
    s = await state();
    assert.ok(Object.values(s).every(v=>!v.visible && !v.classes), 'hide cancels all pending layers');
    await page.evaluate(() => { probe.show(true); probe.ready.tempera=true; probe.frame(1100); });
    s = await state();
    assert.equal(s.tempera.opacity, 1, 'show does not revive stale fade state');
    assert.equal(s.classic.visible, false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: cold start, shared duration, pause/resume, seek, manual selection, reduced motion, rapid switches and hide/show`);
  } finally { await page.close(); }
}
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for(const viewport of [{width:1440,height:960},{width:390,height:844}]) await run(browser, viewport);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
