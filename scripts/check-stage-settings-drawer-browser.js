'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl, uiToken } = require('./ui-token');
const root = path.resolve(__dirname, '..');
const base = process.env.PLAYER_UI_URL || 'http://127.0.0.1:18796';
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.PLAYER_SOURCE_ASSETS === '1') await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        const response = await route.fetch();
        return route.fulfill({ response, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', uiToken()) });
      }
      const file = path.join(root, 'plugin/ui', decodeURIComponent(url.pathname));
      if (!url.pathname.startsWith('/v1/') && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
      return route.continue();
    });
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Stage3D && window.Space3D && document.getElementById('conn').textContent === '\u670d\u52a1\u5df2\u8fde\u63a5');
    await page.evaluate(() => Stage3D.open('aurora'));
    // open 是异步装载：active 置位前 pokeChrome 空转，指针唤醒不生效（见 wakeGear）。
    await page.waitForFunction(() => Stage3D.isActive());
    // s3d chrome 静置 2.6s 打烊（FAB pointer-events:none），而 Playwright 的
    // hit-target 校验不派发 pointermove——唤醒必须「动指针 + 等到 FAB 真的醒」，
    // 再立刻点击；单次 mouse.move 后隔了几步再点会撞上打烊窗口（2026-11-21 实测）。
    const wakeGear = async (vw = 720, vh = 450) => {
      await page.mouse.move(vw / 2, vh / 2);
      await page.waitForFunction(() => Number(
        getComputedStyle(document.getElementById('s3d-settings-toggle')).opacity) === 1);
    };
    check(await page.locator('.s3d-head button').count() === 1, 'top right contains only close');
    check(await page.locator('#s3d-head-trigger').count() === 0, 'old hover toolbar removed');
    const trigger = page.locator('#s3d-settings-toggle'), panel = page.locator('#s3d-settings');
    check(await trigger.evaluate(el => el.classList.contains('sp-fab')), 'settings uses the shared floating gear');
    const styles = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { width: r.width, height: r.height, top: r.top, right: innerWidth - r.right, radius: s.borderRadius, padding: s.padding, background: s.backgroundColor };
    };
    await wakeGear();
    await trigger.click();
    await page.waitForFunction(() => document.getElementById('s3d-settings').getAnimations().every(a => a.playState === 'finished'));
    check(await trigger.getAttribute('aria-expanded') === 'true' && await panel.isVisible(), 'one click opens settings');
    const stageStyles = await panel.evaluate(styles);
    // 形态从「居中圆角弹窗」改回「贴右全高玻璃侧栏」：设置是边看边调的工具，
    // 量用户能看见的位置与尺寸——贴视口右缘、通高、无圆角。
    check(stageStyles.top <= 1 && stageStyles.right <= 1 && stageStyles.height >= 860
      && parseFloat(stageStyles.radius) === 0, 'settings is a full-height right drawer, not a centred dialog');
    check(await page.locator('#s3d-settings-scrim').count() === 0, 'non-modal drawer has no scrim');
    check(await page.locator('#s3d-sec-nav [data-sec]').count() === 5
      && await page.locator('#s3d-settings > .s3d-sec').count() === 5,
      'five section shortcuts each have a matching section heading');
    check(await panel.evaluate(el => getComputedStyle(el).display === 'grid'
      && getComputedStyle(el).gridTemplateColumns.split(' ').length >= 2),
      'settings lays fields out in two columns');
    check(await panel.locator('#s3d-lyrics-toggle').isVisible(), 'lyrics control lives in settings');
    const lyrics = panel.locator('#s3d-lyrics-toggle');
    await lyrics.uncheck();
    check(await page.evaluate(() => !Stage3D.preferences().lyrics), 'lyrics checkbox updates the preference');
    await page.locator('#s3d-settings-close').focus();
    await page.keyboard.press('l');
    check(await lyrics.isChecked(), 'L shortcut updates the checkbox');
    await page.locator('#s3d-motion').fill('40');
    await page.locator('#s3d-motion').dispatchEvent('change');
    check(await page.evaluate(() => Stage3D.preferences().motion === .4), 'motion slider remains functional');
    check(await panel.locator('#s3d-reset').count() === 1 && await panel.locator('#s3d-fs').count() === 1, 'camera and fullscreen actions live in settings');
    await panel.locator('#s3d-fs').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'stage3d');
    check(await panel.locator('#s3d-fs').getAttribute('aria-pressed') === 'true', 'fullscreen action works inside the drawer');
    await panel.locator('#s3d-fs').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    check(await panel.locator('#s3d-fs').getAttribute('aria-pressed') === 'false', 'fullscreen action exits without closing settings');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => Stage3D.isActive()) && await trigger.getAttribute('aria-expanded') === 'false', 'Escape closes drawer before leaving stage');
    check(await trigger.evaluate(el => el === document.activeElement), 'closing returns focus to gear');
    await wakeGear();
    await trigger.click();
    await page.locator('#s3d-settings-close').click();
    check(await trigger.getAttribute('aria-expanded') === 'false', 'close button updates drawer state');
    await page.evaluate(() => { Stage3D.close(); Space3D.open(); });
    // Space3D 开启带一段 warp 入场动画，动画未落定时 FAB 在视口外且命中测试落空。
    // 这里等 warp 结束；其后 FAB 的命中测试在 headless 下仍会**间歇性**落空
    // （元素可见、pe:auto、坐标正确却报 body 拦截——master 上同款时序也会中招，
    //  2026-11-21 实测），所以两下点击直接派发事件：这一段要验证的是点完之后
    // sp-sheet 的几何与关闭键尺寸，不是命中路径本身。
    await page.waitForFunction(() => !document.querySelector('.sp').classList.contains('sp-warping'));
    await page.locator('#sp-more').dispatchEvent('click');
    await page.locator('#sp-fab').dispatchEvent('click');
    await page.waitForFunction(() => document.getElementById('sp-sheet').getAnimations().every(a => a.playState === 'finished'));
    const spaceStyles = await page.locator('#sp-sheet').evaluate(styles);
    check(spaceStyles.top >= 0 && spaceStyles.right >= 0 && spaceStyles.height <= 900, 'space console remains within its viewport');
    check(await page.locator('#sp-sheet-close').evaluate(el => el.getBoundingClientRect().width === 40 && el.getBoundingClientRect().height === 40), 'both setting surfaces keep 40px close controls');
    await page.evaluate(() => { Space3D.close(); Stage3D.open('aurora'); });
    const out = path.join(root, 'output/playwright/stage-settings-drawer'); fs.mkdirSync(out, { recursive: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 844 },
      { width: 390, height: 844 }, { width: 760, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.screenshot({ path: path.join(out, viewport.width + '-closed.png'), animations: 'disabled' });
      await page.locator('#s3d-play').click({ trial: true });
      check(await page.locator('.s3d-play-buttons').evaluate(el => el.getBoundingClientRect().width >= 120 && el.scrollWidth <= el.clientWidth + 1), viewport.width + ' playback buttons remain visible and clickable');
      check(await page.locator('#s3d-dock').evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('s3d-player').getBoundingClientRect().top), viewport.width + ' scene dock clears playback controls');
      check(await trigger.evaluate(el => {
        const r = el.getBoundingClientRect();
        const player = document.getElementById('s3d-player').getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight &&
          (r.right <= player.left || r.left >= player.right || r.bottom <= player.top || r.top >= player.bottom);
      }), viewport.width + ' floating gear clears playback bar');
      await wakeGear(viewport.width, viewport.height);
      await trigger.click();
      await page.waitForFunction(() => document.getElementById('s3d-settings').getAnimations().every(a => a.playState === 'finished'));
      check(await panel.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth + 1), viewport.width + ' drawer scrolls vertically without horizontal overflow');
      await page.screenshot({ path: path.join(out, viewport.width + '-open.png'), animations: 'disabled' });
      await page.locator('#s3d-settings-close').click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await wakeGear();
    await trigger.click();
    // 侧栏是非模态的：点舞台不收起（用户要边看边调），Esc 与关闭键负责收起。
    await page.mouse.click(360, 450);
    await page.waitForTimeout(150);
    check(await trigger.getAttribute('aria-expanded') === 'true', 'clicking the stage keeps the drawer open');
    await page.keyboard.press('Escape');
    check(await trigger.getAttribute('aria-expanded') === 'false', 'Escape still closes the drawer');
    await page.evaluate(() => Stage3D.close());
    await page.evaluate(() => Stage3D.open('aurora'));
    check(await trigger.getAttribute('aria-expanded') === 'false', 'reopening starts with drawer closed');
    check(errors.length === 0, 'no browser errors: ' + errors.join('; '));
    console.log(checks + ' drawer checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
