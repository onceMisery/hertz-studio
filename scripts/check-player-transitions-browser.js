'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { routeSourceAssets } = require('./ui-source-assets');
const output = path.resolve(__dirname, '../output/playwright/player-transitions');

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    await fixture.connect(context);
    const track = await fixture.seed();
    const { token } = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8'));
    const cover = await context.request.post(fixture.base + '/v1/tracks/' + track.id + '/cover', {
      headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token }, data: fs.readFileSync(path.resolve(__dirname, '../plugin/ui/wallpapers/celestial-sky.jpg')),
    });
    assert.ok(cover.ok(), 'Fixture cover uploaded');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('vmusic.defaultView', 'library'));
    await routeSourceAssets(page, fixture);
    await page.goto(fixture.base);
    await page.waitForFunction(() => window.NowPlaying && document.getElementById('bar-track').onclick && document.getElementById('conn').textContent === '服务已连接');
    assert.equal(await page.locator('#player-cover-transition').count(), 1, 'Appearance offers a cover transition selector');
    assert.equal(await page.locator('#player-stage-transition').count(), 1, 'Appearance offers a separate stage transition selector');
    assert.equal(await page.locator('#player-cover-transition').inputValue(), 'zoom');
    assert.equal(await page.locator('#player-cover-duration').inputValue(), '1000');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('bar-art')).backgroundImage !== 'none');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'before.png') });

    async function finish() {
      await page.evaluate(async () => {
        document.getAnimations().filter(a => a.id.startsWith('player-transition-')).forEach(a => a.finish());
        await Promise.resolve(); await Promise.resolve();
      });
    }
    async function configure(kind, effect, duration = 650) {
      await page.evaluate(({ kind, effect, duration }) => {
        const select = document.getElementById('player-' + kind + '-transition');
        select.value = effect; select.dispatchEvent(new Event('change', { bubbles: true }));
        const slider = document.getElementById('player-' + kind + '-duration');
        slider.value = duration; slider.dispatchEvent(new Event('input', { bubbles: true }));
      }, { kind, effect, duration });
    }
    async function enterCover(effect) {
      await configure('cover', effect);
      return page.evaluate(() => {
        const source = document.getElementById('bar-art').getBoundingClientRect().toJSON();
        document.getElementById('bar-track').click();
        const animations = document.getAnimations().filter(a => a.id.startsWith('player-transition-'));
        animations.forEach(a => { a.pause(); a.currentTime = 0; });
        const ghost = document.querySelector('.player-transition-cover');
        const start = ghost && ghost.getBoundingClientRect().toJSON();
        animations.forEach(a => { a.currentTime = 325; });
        return { source, start, mid: ghost && ghost.getBoundingClientRect().toJSON(),
          target: document.getElementById('np-art').getBoundingClientRect().toJSON(),
          animations: animations.map(a => ({ id: a.id, duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes() })) };
      });
    }
    async function checkCoverLanding(effect) {
      const landing = await page.evaluate(() => {
        const animations = document.getAnimations().filter(a => a.id.startsWith('player-transition-'));
        const ghost = document.querySelector('.player-transition-cover');
        const art = document.getElementById('np-art');
        animations.forEach(a => { a.currentTime = a.effect.getTiming().duration * .93; });
        const crossfade = { ghost: Number(getComputedStyle(ghost).opacity), art: Number(getComputedStyle(art).opacity) };
        animations.forEach(a => { a.currentTime = a.effect.getTiming().duration - .01; });
        return { crossfade, end: { ghost: Number(getComputedStyle(ghost).opacity), art: Number(getComputedStyle(art).opacity) },
          targetShadow: getComputedStyle(art).boxShadow };
      });
      assert.notEqual(landing.targetShadow, 'none', 'Fixture exercises the real cover material');
      assert.ok(landing.crossfade.ghost > 0 && landing.crossfade.ghost < 1 && landing.crossfade.art > 0,
        effect + ': the real cover and its shadow appear during landing, before cleanup');
      assert.ok(landing.end.ghost < .01 && landing.end.art > .99,
        effect + ': removing the temporary cover cannot cause a final-frame material jump');
      await page.screenshot({ path: path.join(output, 'cover-' + effect + '-landing.png') });
    }
    const zoom = await enterCover('zoom');
    assert.ok(zoom.start, 'Zoom creates a shared cover, not a whole-page scale');
    assert.ok(Math.abs(zoom.start.x - zoom.source.x) < 1 && Math.abs(zoom.start.width - zoom.source.width) < 1, 'Cover starts at the real bottom-bar bounds');
    assert.ok(zoom.mid.width > zoom.source.width && zoom.mid.width < zoom.target.width, 'Cover travels through intermediate sizes');
    assert.ok((zoom.mid.width - zoom.source.width) / (zoom.target.width - zoom.source.width) < .85, 'At halfway, a visible part of the enlargement remains');
    assert.ok(zoom.animations.every(a => a.duration === 650), 'Configured timing reaches every transition layer');
    await page.screenshot({ path: path.join(output, 'cover-mid.png') });
    await checkCoverLanding('zoom');
    await finish();
    assert.equal(await page.locator('.player-transition-cover').count(), 0, 'Completion removes the cover copy');
    await page.screenshot({ path: path.join(output, 'cover-after.png') });
    await page.locator('#np-close').click();
    for (const effect of ['flip', 'fade', 'off']) {
      const result = await enterCover(effect);
      if (effect === 'off') assert.equal(result.animations.length, 0, 'Off leaves no page or cover animation');
      else assert.ok(result.animations.length > 0, effect + ' creates a transition');
      if (effect === 'flip') {
        assert.ok(result.animations.some(a => a.frames.some(f => /rotateY\(-360deg\)/.test(f.transform || ''))), 'Flip makes a complete turn rather than a small tilt');
        assert.equal(await page.locator('.player-transition-face').count(), 2, 'The turning card has a readable front and back');
        await page.screenshot({ path: path.join(output, 'cover-flip-mid.png') });
        await checkCoverLanding('flip');
      }
      if (effect === 'fade') {
        assert.ok(result.start && result.mid.width > result.target.width, 'Fade spreads the actual cover beyond the album tile');
        const frame = result.animations.find(a => a.id === 'player-transition-cover');
        assert.equal(frame.frames.at(-1).opacity, '0', 'The expanded cover dissolves to reveal playback');
        await page.screenshot({ path: path.join(output, 'cover-fade-mid.png') });
      }
      await finish();
      await page.locator('#np-close').click();
    }
    await enterCover('zoom');
    const changedView = await page.evaluate(() => {
      document.getElementById('np-tab-lyrics').click();
      return { copies: document.querySelectorAll('.player-transition-cover').length,
        animations: document.getAnimations().filter(a => a.id.startsWith('player-transition-')).length };
    });
    assert.deepEqual(changedView, { copies: 0, animations: 0 }, 'Changing the cover layout cancels its obsolete destination');
    await page.locator('#np-tab-cover').click();
    await page.locator('#np-close').click();
    await configure('cover', 'zoom', 1000);
    const rapid = await page.evaluate(() => {
      const open = document.getElementById('bar-track'), close = document.getElementById('np-close');
      open.click(); close.click(); open.click(); close.click();
      return { copies: document.querySelectorAll('.player-transition-cover').length,
        hidden: document.getElementById('np-modal').hidden, inert: document.querySelector('.bar').inert,
        entering: document.body.classList.contains('player-entering'),
        animations: document.getAnimations().filter(a => a.id.startsWith('player-transition-')).length };
    });
    assert.deepEqual(rapid, { copies: 0, hidden: true, inert: false, entering: false, animations: 0 }, 'Rapid switching releases all temporary state');
    for (const effect of ['zoom', 'flip', 'fade', 'off']) {
      await configure('stage', effect, 900);
      await configure('cover', 'off');
      await page.locator('#bar-track').click();
      const stage = await page.evaluate(() => {
        document.getElementById('np-stage').click();
        const root = document.getElementById('stage3d');
        const animations = root.getAnimations({ subtree: true }).filter(a => a.id.startsWith('player-transition-'));
        animations.forEach(a => { a.pause(); a.currentTime = 450; });
        return { active: Stage3D.isActive(), inert: document.getElementById('np-modal').inert,
          animations: animations.map(a => ({ duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes() })) };
      });
      assert.ok(stage.active && stage.inert, 'Stage retains its existing ownership');
      assert.equal(stage.animations.length, effect === 'off' ? 0 : 1, effect + ' stage entrance uses one bounded animation');
      if (effect !== 'off') assert.equal(stage.animations[0].duration, 900);
      if (effect === 'flip') assert.ok(stage.animations[0].frames.some(f => /rotateY/.test(f.transform || '') || /^y /.test(f.rotate || '')));
      await page.waitForFunction(() => document.fullscreenElement?.id === 'stage3d');
      if (effect === 'zoom' || effect === 'flip') {
        const transformed = await page.evaluate(() => {
          const animation = document.getAnimations().find(a => a.id === 'player-transition-stage');
          animation.currentTime = 180;
          return { width: animation.effect.target.getBoundingClientRect().width, viewport: innerWidth };
        });
        assert.ok(transformed.width < transformed.viewport - 10, effect + ' remains visibly transformed after native fullscreen starts');
        await page.screenshot({ path: path.join(output, 'stage-' + effect + '-mid.png') });
      }
      await finish();
      await page.evaluate(() => Stage3D.close());
      await page.waitForFunction(() => !document.fullscreenElement);
      assert.equal(await page.locator('#np-modal').isVisible(), true, 'Closing stage returns to ordinary playback');
      assert.equal(await page.locator('#np-modal').evaluate(el => el.inert), false);
      await page.locator('#np-close').click();
    }
    await configure('cover', 'zoom');
    const withoutCover = await page.evaluate(() => {
      const art = document.getElementById('bar-art'), image = art.style.backgroundImage;
      art.style.backgroundImage = 'none'; document.getElementById('bar-track').click();
      const copies = document.querySelectorAll('.player-transition-cover').length;
      art.style.backgroundImage = image;
      return copies;
    });
    assert.equal(withoutCover, 0, 'An absent source cover uses the page fade without a fabricated artwork');
    await finish(); await page.locator('#np-close').click();
    await enterCover('zoom');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForFunction(() => !document.querySelector('.player-transition-cover'));
    assert.equal(await page.locator('#np-modal').isVisible(), true, 'Resize cancels motion without closing playback');
    await page.locator('#np-close').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await enterCover('zoom');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !document.querySelector('.player-transition-cover'));
    assert.equal(await page.locator('#np-art').evaluate(el => getComputedStyle(el).opacity), '1', 'Enabling reduced motion in flight restores the actual cover');
    await page.locator('#np-close').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await configure('cover', 'zoom', 800);
    await configure('stage', 'flip', 950);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('bar-track').onclick);
    assert.equal(await page.locator('#player-cover-duration').inputValue(), '800');
    assert.equal(await page.locator('#player-stage-transition').inputValue(), 'flip');
    assert.equal(await page.locator('#player-stage-duration').inputValue(), '950');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await enterCover('zoom');
    assert.equal(reduced.animations.length, 0, 'System reduced motion bypasses animation');
    await page.locator('#np-close').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.add('reduce-motion'));
    assert.equal((await enterCover('flip')).animations.length, 0, 'Application reduced motion bypasses animation');
    await page.locator('#np-close').click();
    await page.evaluate(() => document.body.classList.remove('reduce-motion'));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await enterCover('zoom');
    assert.ok(mobile.start && mobile.target.width > mobile.source.width, 'Narrow layout also uses actual cover geometry');
    await finish();
    await page.screenshot({ path: path.join(output, 'mobile-after.png') });
    await page.locator('#np-close').click();
    await page.evaluate(() => { setView('settings'); document.getElementById('player-cover-transition').scrollIntoView({ block: 'center' }); });
    await page.screenshot({ path: path.join(output, 'mobile-settings.png') });
    assert.ok(await page.locator('#player-stage-duration').evaluate(el => el.getBoundingClientRect().right <= innerWidth), 'Narrow settings keep sliders within the viewport');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.getElementById('player-cover-transition').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.addInitScript(() => {
      localStorage.removeItem('vmusic.player.transitions.v1');
      Object.defineProperty(window, 'hertzHost', { configurable: true, set(host) {
        const hydrate = host.hydrate;
        host.hydrate = async () => {
          await hydrate();
          localStorage.setItem('vmusic.player.transitions.v1', JSON.stringify({ cover: { effect: 'flip', duration: 1100 }, stage: { effect: 'fade', duration: 1200 } }));
        };
        Object.defineProperty(window, 'hertzHost', { configurable: true, writable: true, value: host });
      } });
    });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('bar-track').onclick);
    assert.equal(await page.locator('#player-cover-transition').inputValue(), 'flip', 'Host hydration finishes before reading transition preferences');
    assert.equal(await page.locator('#player-stage-duration').inputValue(), '1200');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log('PASS cover geometry, variants, timing, interruption, native fullscreen, stage ownership, persistence, reduced motion, narrow layout and delayed host hydration');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
