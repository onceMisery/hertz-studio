// SPDX-License-Identifier: MIT
// Real component identity/rollback/resize and button-state regressions.
// HERTZ_BIN=<built service> PLAYWRIGHT_MODULE=<module> node scripts/check-shell-layout-browser.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const web = process.env.HERTZ_UI_ASSETS ? path.resolve(process.env.HERTZ_UI_ASSETS) : path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/playwright/layout');
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }

(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    await fixture.seed();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await fixture.connect(context);
    const token = fs.readFileSync(path.join(fixture.dataDir, 'token'), 'utf8').trim();
    await context.grantPermissions(['local-network-access'], { origin: fixture.base });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(fixture.base + '/**', route => {
      const relative = decodeURIComponent(new URL(route.request().url()).pathname).slice(1) || 'index.html';
      const file = path.resolve(web, relative);
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
      let body = fs.readFileSync(file);
      if (relative === 'index.html') body = body.toString().replace('__VMUSIC_TOKEN_VALUE__', token);
      const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
      return route.fulfill({ body, contentType: mime[path.extname(file)] || 'application/octet-stream' });
    });
    await page.goto(fixture.base);
    await page.waitForFunction(() => window.HertzShell && HertzShell.activeView());
    async function skin(id) {
      await page.evaluate(id => Skins.apply(id), id);
      await page.waitForFunction(id => document.documentElement.dataset.skin === id, id);
    }
    await skin('classic');
    await page.evaluate(() => {
      window.layoutBaseline = Array.from(document.querySelectorAll('[data-shell-component]'), node =>
        ({ name: node.dataset.shellComponent, node, parent: node.parentNode, next: node.nextSibling }));
      window.layoutEvents = 0;
      document.getElementById('mode').addEventListener('layout-test', () => { window.layoutEvents++; });
    });
    async function unchanged(label) {
      const wrong = await page.evaluate(() => window.layoutBaseline.filter(r =>
        document.querySelectorAll('[data-shell-component="' + r.name + '"]').length !== 1 ||
        document.querySelector('[data-shell-component="' + r.name + '"]') !== r.node ||
        r.node.parentNode !== r.parent || r.node.nextSibling !== r.next).map(r => r.name));
      check(wrong.length === 0, label + ': ' + wrong.join(', '));
    }

    const rejection = await page.evaluate(() => {
      const shell = HertzShell;
      const rejected = [];
      const bad = [
        { placements: [{ component: document.getElementById('mode'), target: 'navigation' }] },
        { placements: [{ component: 'view-room', target: 'navigation' }] },
        { placements: [{ component: 'stage.artwork', target: document.body }] },
        { regions: { stolen: document.getElementById('view-room') } },
        { placements: [{ component: 'stage.artwork', target: 'missing' }] },
        // Invalid complete description must leave no created regions.
        { regions: { temporary: { className: 'layout-failure-region', parent: 'navigation' } }, placements: [
          { component: 'stage.artwork', target: 'temporary' },
          { component: 'player.mode', target: 'player', before: 'stage.title' },
        ] },
        { regions: { cycle: { parent: 'stage' } }, placements: [{ component: 'stage', target: 'cycle' }] },
        { media: '(max-width: 1px)', placements: [{ component: 'stage.artwork', target: 'navigation', before: 'missing' }] },
      ];
      bad.forEach((description, i) => {
        try { const handle = shell.assembleLayout('invalid-' + i, description); handle.dispose(); rejected.push(false); }
        catch (_) { rejected.push(!shell.isLayoutAssembled('invalid-' + i)); }
      });
      return { rejected, retired: typeof shell.beginLayout === 'undefined', clean: !document.querySelector('.layout-failure-region') };
    });
    check(rejection.retired, '任意节点搬运 API 已退役');
    check(rejection.rejected.every(Boolean) && rejection.clean, '拒绝未公开组件、任意节点、未知目标和循环；失败原子回滚');
    await unchanged('拒绝非法装配后完整恢复');

    // DOM 插入本身仍可能抛错（宿主/定制元素）。验证已执行的第一步也会被撤销。
    const partialFailure = await page.evaluate(() => {
      const target = HertzShell.region('player');
      const append = target.appendChild;
      let rejected = false;
      target.appendChild = function () { throw new Error('injected host insertion failure'); };
      try {
        HertzShell.assembleLayout('host-failure', { placements: [
          { component: 'stage.artwork', target: 'navigation' },
          { component: 'player.mode', target: 'player' },
        ] });
      } catch (_) { rejected = !HertzShell.isLayoutAssembled('host-failure'); }
      finally { target.appendChild = append; }
      return rejected;
    });
    check(partialFailure, '宿主在中途拒绝插入时撤销已经完成的操作');
    await unchanged('中途失败后全部组件回到原位');

    const ownership = await page.evaluate(() => {
      const first = HertzShell.assembleLayout('first', { placements: [{ component: 'stage.artwork', target: 'navigation' }] });
      let refused = false;
      try { HertzShell.assembleLayout('second', { placements: [{ component: 'stage.artwork', target: 'player' }] }); }
      catch (_) { refused = true; }
      const intact = HertzShell.isLayoutAssembled('first') && !HertzShell.isLayoutAssembled('second');
      first.dispose(); first.dispose();
      return refused && intact;
    });
    check(ownership, '组件只归一份布局持有；拒绝竞争且可重复释放');
    await unchanged('释放布局后原顺序恢复');

    await page.evaluate(() => {
      window.mutationOwner = HertzShell.assembleLayout('mutation-owner', { placements: [{ component: 'player.mode', target: 'navigation' }] });
      const description = { media: '(max-width: 767px)', placements: [{ component: 'stage.artwork', target: 'navigation' }] };
      window.mutationLayout = HertzShell.assembleLayout('mutation-probe', description);
      description.placements[0].component = 'player.mode';
      description.placements[0].target = 'player';
      description.placements.push({ component: 'stage.title', target: 'navigation' });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#rail > [data-shell-component="stage.artwork"]'));
    check(await page.evaluate(() => document.querySelector('#rail > [data-shell-component="player.mode"]') &&
      !document.querySelector('#rail > [data-shell-component="stage.title"]')), '响应式布局复制描述，不偷取未认领组件');
    await page.evaluate(() => { window.mutationLayout.dispose(); window.mutationOwner.dispose(); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await unchanged('调用方修改描述后仍正确还原');

    await skin('liunian');
    const skinFailure = await page.evaluate(() => {
      const entry = Skins.catalog().find(def => def.id === 'orbit');
      const original = entry.lifecycle;
      let failure = false;
      entry.lifecycle = {
        mount() { original.mount(); throw new Error('injected skin lifecycle failure'); },
        unmount: original.unmount,
      };
      try { Skins.apply('orbit'); }
      catch (_) { failure = true; }
      finally { entry.lifecycle = original; }
      return failure && Skins.currentId() === 'liunian' && document.documentElement.dataset.skin === 'liunian' &&
        HertzShell.isLayoutAssembled('liunian') && !HertzShell.isLayoutAssembled('orbit') && !HertzShell.isLayoutAssembled('orbit-player') &&
        !document.querySelector('.orbit-main') && !!document.querySelector('.ln-right > #stage') &&
        window.layoutBaseline.every(r => document.querySelector('[data-shell-component="' + r.name + '"]') === r.node);
    });
    check(skinFailure, '目标皮肤挂载中途失败时清理目标并恢复前一皮肤的组件实例');
    await skin('classic');
    await unchanged('皮肤生命周期失败恢复后仍保持原顺序');

    check(await page.evaluate(() => HertzShell.hasComponent('account') === !!document.getElementById('online-account-btn')),
      '发行版省略账号入口时，组件可用性与实际交付一致');

    for (let cycle = 0; cycle < 2; cycle++) {
      if (cycle === 1) await fixture.api('/v1/player/play', 'POST', {});
      const playback = await fixture.api('/v1/state');
      check(playback.playing === (cycle === 1), `${cycle === 0 ? '暂停' : '播放中'}换肤前置状态已确认`);
      for (const id of ['orbit', 'liunian', 'qingfeng', 'heijiao']) {
        await skin(id);
        const identity = await page.evaluate(() => window.layoutBaseline.every(r =>
          document.querySelector('[data-shell-component="' + r.name + '"]') === r.node) &&
          document.querySelectorAll('#view-settings').length === 1);
        check(identity, `${id} 第 ${cycle + 1} 次挂载保留组件实例及唯一设置视图`);
        await skin('classic');
        await unchanged(id + ' 卸载后所有组件严格回位');
        const after = await fixture.api('/v1/state');
        check(playback.track_id === after.track_id && playback.playing === after.playing,
          `${id} 布局交接保留服务的${playback.playing ? '播放中' : '暂停'}状态及曲目`);
      }
    }
    await fixture.api('/v1/player/pause', 'POST', {});
    const eventCount = await page.evaluate(() => {
      document.getElementById('mode').dispatchEvent(new Event('layout-test'));
      return window.layoutEvents;
    });
    check(eventCount === 1, '组件原有监听器保留且未重复');

    await skin('orbit');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#np-tools > [data-shell-component="nowPlaying.volume"]'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector('#np-tools > [data-shell-component="nowPlaying.volume"]'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#np-tools > [data-shell-component="nowPlaying.volume"]'));
    await skin('classic');
    await unchanged('窄屏卸载星轨后音量组件归还');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    await unchanged('已卸载的媒体监听不会重新装配');
    await page.setViewportSize({ width: 1440, height: 1000 });

    fs.mkdirSync(output, { recursive: true });
    for (const id of ['classic', 'orbit', 'liunian', 'qingfeng', 'heijiao']) {
      await skin(id);
      await page.evaluate(() => {
        HertzShell.navigate('room');
        const probe = document.createElement('section');
        probe.id = 'button-state-probe'; probe.className = 'room-section';
        probe.innerHTML = '<button type="button" id="state-primary" class="btn touch flat primary">发送</button> <button type="button" id="state-secondary" class="btn touch flat">取消</button>';
        document.getElementById('view-room').prepend(probe);
      });
      for (const theme of ['mineral', 'ios-light']) {
        await page.evaluate(theme => Theme.apply(theme, { silent: true }), theme);
        await page.mouse.move(1430, 990);
        const button = page.locator('#state-primary');
        const read = () => button.evaluate(el => {
          const cs = getComputedStyle(el);
          return { background: cs.backgroundColor, color: cs.color, height: cs.minHeight, shadow: cs.boxShadow, radius: cs.borderRadius, transition: cs.transitionProperty };
        });
        const rest = await read();
        check(rest.transition === 'none', `${id}/${theme} 减少动态效果时关闭按钮过渡`);
        await button.hover();
        await page.waitForTimeout(250);
        const hover = await read();
        check(rest.background === hover.background && rest.color === hover.color && rest.color !== rest.background,
          `${id}/${theme} 主按钮悬停保留前景背景组合`);
        check(hover.height === '44px' && hover.shadow === 'none' && hover.radius === '8px', `${id}/${theme} touch/flat 变体不被皮肤基础样式覆盖`);
        if (id === 'orbit' && theme === 'mineral') await page.locator('#button-state-probe').screenshot({ path: path.join(output, 'room-primary-hover.png') });
        await page.mouse.down();
        check(await button.evaluate(el => getComputedStyle(el).transform !== 'none'), `${id}/${theme} 保留按压反馈`);
        await page.mouse.up();
        await button.evaluate(el => { el.disabled = true; });
        check(await button.evaluate(el => getComputedStyle(el).cursor === 'not-allowed' && getComputedStyle(el).transform === 'none'), `${id}/${theme} 禁用态不执行按压变换`);
        await button.evaluate(el => { el.disabled = false; el.focus(); });
        await page.keyboard.press('Tab');
        check(await page.locator('#state-secondary').evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'), `${id}/${theme} 键盘焦点可见`);
      }
      await page.locator('#button-state-probe').evaluate(el => el.remove());
    }
    await skin('classic');
    await unchanged('交互态检查后组件仍完整');
    check(errors.length === 0, '页面零未捕获异常: ' + errors.join(' | '));
    console.log(`外壳布局与按钮回归：${checks} 项通过`);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
