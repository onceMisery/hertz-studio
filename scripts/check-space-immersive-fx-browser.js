#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 沉浸模式 ↔ 正常模式的可配置切换动画：开关/类型/时长即改即生效、快速连切不叠加、
// 状态一致、既有动效（播放条自动隐藏、弹层开合）不被接管。
// 自起隔离夹具 + node 代理回源磁盘 UI（无需重建二进制）：
//   PLAYWRIGHT_MODULE=... node scripts/check-space-immersive-fx-browser.js
// --serve 只起预览服务供手工查看。
//
// 测量手法：headless swiftshader 会把主线程 rAF 饿到 ~0.4fps，「动作后等 Nms 再
// 采样」量到的是相位噪声。这里改用 WAAPI 直接读过渡对象：click 后在页内等
// getAnimations() 出现，读 duration/delay/keyframes 钉接线，再把动画 pause 到
// currentTime=0.4*duration 读 computed style 钉中间值——全程不依赖 rAF 频率。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { startFixture } = require('./ui-browser-fixture');
const web = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/space-immersive-fx');

async function startPreview() {
  const fixture = await startFixture();
  try {
    await fixture.api('/v1/settings', 'PUT', { space3d: { sceneSource: 'coast', qualityMode: 'low', playerAutoHide: false } });
    const discovery = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json')));
    const upstream = new URL(fixture.base);
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/v1/')) {
        const proxy = http.request(fixture.base + req.url, { method: req.method,
          headers: { ...req.headers, host: upstream.host, authorization: 'Bearer ' + discovery.token } }, reply => {
          res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
        });
        proxy.on('error', error => { res.writeHead(502); res.end(error.message); });
        req.pipe(proxy); return;
      }
      const file = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end(); return;
      }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      const body = pathname === '/' ? fs.readFileSync(file, 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', discovery.token) : fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
    });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => {
      const remote = net.connect(Number(upstream.port), upstream.hostname, () => {
        remote.write('GET ' + req.url + ' HTTP/1.1\r\n' + Object.entries({ ...req.headers,
          host: upstream.host, origin: fixture.base, authorization: 'Bearer ' + discovery.token })
          .map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
        if (head.length) remote.write(head);
        socket.pipe(remote); remote.pipe(socket);
      });
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { fixture, base: 'http://127.0.0.1:' + server.address().port,
      async close() { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); await fixture.close(); } };
  } catch (error) { await fixture.close(); throw error; }
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const preview = await startPreview();
  if (process.argv.includes('--serve')) {
    console.log('Immersive fx preview: ' + preview.base);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
    return;
  }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-features=LocalNetworkAccessChecks'] });
  const errors = [], checks = [];
  const pass = label => { checks.push(label); console.log('PASS ' + label); };
  const evidence = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && window.Stage, null, { timeout: 30000 });
    await page.waitForTimeout(300); // 启动 settings 响应必须到达 configure()

    const probe = () => page.evaluate(() => {
      const root = document.getElementById('space3d'), bar = document.getElementById('sp-bar');
      const cs = getComputedStyle(bar);
      return {
        immersive: root.classList.contains('sp-immersive'), switching: root.classList.contains('sp-imm-switching'),
        fx: root.dataset.immFx || '', dur: root.style.getPropertyValue('--sp-imm-dur'),
        opacity: Number(cs.opacity), visibility: cs.visibility, scale: cs.scale, rotate: cs.rotate, translate: cs.translate,
        transitionDuration: cs.transitionDuration, animations: bar.getAnimations().length, barInert: bar.inert,
        pressed: document.getElementById('sp-stage-immersive').getAttribute('aria-pressed'),
        pressedMenu: document.getElementById('sp-immersive').getAttribute('aria-pressed'),
        checked: document.getElementById('sp-immersive-toggle').checked,
        focus: document.activeElement && document.activeElement.id,
        readingVisibility: getComputedStyle(document.getElementById('sp-reading')).visibility,
        canvasVisibility: getComputedStyle(document.getElementById('sp-canvas')).visibility,
      };
    });
    // 同步触发切换并立即读过渡对象：on=true 点沉浸按钮，false 走 Escape（按钮已 inert）。
    // 页内 setTimeout 轮询等过渡创建（rAF 被饿死时 timer 仍能挤进去），拿到后读
    // duration/delay/keyframes；midRead 时把每条过渡 pause 到 40% 处读 computed 中间值。
    const inspectToggle = (on, midRead) => page.evaluate(async ({ on, midRead }) => {
      const root = document.getElementById('space3d'), bar = document.getElementById('sp-bar');
      if (on) { const btn = document.getElementById('sp-stage-immersive'); btn.focus(); btn.click(); }
      else document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
      const specAtClick = getComputedStyle(bar).transitionDuration;
      const csAtClick = getComputedStyle(bar);
      const propertySpec = csAtClick.transitionProperty, delaySpec = csAtClick.transitionDelay;
      let anims = [];
      for (let i = 0; i < 300; i++) { anims = bar.getAnimations(); if (anims.length) break; await new Promise(r => setTimeout(r, 10)); }
      const captured = anims.map(a => {
        const t = a.effect.getTiming();
        const keyframes = a.effect.getKeyframes().map(k => ({ offset: k.offset, opacity: k.opacity, scale: k.scale, rotate: k.rotate, translate: k.translate, visibility: k.visibility }));
        let mid = null;
        if (midRead) {
          a.pause(); a.currentTime = Number(t.duration) * 0.4;
          const cs = getComputedStyle(bar);
          mid = { opacity: Number(cs.opacity), visibility: cs.visibility, scale: cs.scale, rotate: cs.rotate, translate: cs.translate };
          a.finish();
        }
        return { prop: a.transitionProperty, duration: t.duration, delay: t.delay, keyframes, mid };
      });
      return { switching: root.classList.contains('sp-imm-switching'), immersive: root.classList.contains('sp-immersive'),
        fx: root.dataset.immFx, specAtClick, propertySpec, delaySpec, captured };
    }, { on, midRead });
    const byProp = (report, prop) => report.captured.find(a => a.prop === prop);
    const settled = () => page.waitForFunction(() => !document.getElementById('space3d').classList.contains('sp-imm-switching'), null, { timeout: 8000 });
    const setRange = (selector, value) => page.locator(selector).evaluate((el, next) => {
      el.value = String(next); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    const openDisplayTab = async () => {
      await page.locator('#sp-console-toggle').click();
      await page.waitForFunction(() => document.getElementById('sp-sheet').classList.contains('sp-show'));
      await page.locator('#sp-tab-display').click();
    };
    const closeSheet = async () => {
      await page.locator('#sp-sheet-close').click();
      await page.waitForFunction(() => !document.getElementById('sp-sheet').classList.contains('sp-show'));
    };

    // 1. 默认值与接线：缺省配置回落 fade/450，控件/dataset/CSS 变量同步
    const startup = await page.evaluate(() => ({ prefs: { fx: Space3D.preferences().immersiveFx, dur: Space3D.preferences().immersiveFxDur },
      select: document.getElementById('sp-immersive-fx').value, range: document.getElementById('sp-immersive-fx-dur').value,
      output: document.getElementById('sp-immersive-fx-dur-val').textContent }));
    const startupProbe = await probe();
    assert.deepEqual(startup.prefs, { fx: 'fade', dur: 450 });
    assert.equal(startup.select, 'fade'); assert.equal(startup.range, '450'); assert.equal(startup.output, '450 ms');
    assert.equal(startupProbe.fx, 'fade'); assert.equal(startupProbe.dur, '450ms');
    evidence.startup = startup;
    pass('缺省配置回落 fade/450，设置控件与 data-imm-fx/--sp-imm-dur 开机同步');

    // 2. 进入三维空间舞台（真实 open/enterStage 路径），等场景就绪与入场动画结束
    await page.evaluate(() => { Space3D.open(); Space3D.enterStage(); });
    await page.waitForFunction(() => Space3D.stats().page === 'stage' && Space3D.stats().state.state === 'ready', null, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById('sp-warp').hidden, null, { timeout: 15000 });
    const baseline = await probe();
    assert.equal(baseline.immersive, false); assert.equal(baseline.switching, false);
    assert.ok(!baseline.transitionDuration.includes('0.45s'), '非切换态播放条过渡规格不含沉浸时长: ' + baseline.transitionDuration);
    evidence.baselineSpec = baseline.transitionDuration;
    pass('舞台就绪；非切换态播放条保留自己的过渡规格');

    // 3. fade 双向：淡出 visibility 延迟一个时长、opacity 走中间值；落定后状态一致
    // 测量用 1200ms 长档：swiftshader 主线程可能阻塞数百 ms，短档过渡会在捕获前就跑完。
    await page.evaluate(() => Space3D.configure({ immersiveFxDur: 1200 }));
    const out = await inspectToggle(true, true);
    assert.equal(out.switching, true); assert.equal(out.immersive, true);
    assert.ok(out.specAtClick.includes('1.2s'), '淡出规格是配置的 1200ms: ' + out.specAtClick);
    const outOpacity = byProp(out, 'opacity');
    assert.ok(outOpacity && outOpacity.duration === 1200, 'opacity 过渡时长 1200');
    assert.ok(outOpacity.mid && outOpacity.mid.opacity > 0.02 && outOpacity.mid.opacity < 0.98, '淡出中间值: ' + JSON.stringify(outOpacity.mid));
    // visibility 是 0 时长 + 延迟的离散过渡，没有动画对象；钉计算规格的延迟值。
    assert.ok(out.propertySpec.includes('visibility'), 'visibility 在过渡属性里: ' + out.propertySpec);
    assert.ok(out.delaySpec.trim().endsWith('1.2s'), '淡出 visibility 延迟一个时长: ' + out.delaySpec);
    assert.ok(!byProp(out, 'scale') && !byProp(out, 'rotate') && !byProp(out, 'translate'), 'fade 无变换过渡');
    const outState = await probe();
    assert.equal(outState.focus, 'space3d', '进入沉浸焦点交给根节点');
    assert.equal(outState.readingVisibility, 'visible', '歌词层不受沉浸隐藏影响');
    assert.equal(outState.canvasVisibility, 'visible', '场景画布不受沉浸隐藏影响');
    await settled();
    const hiddenState = await probe();
    assert.equal(hiddenState.visibility, 'hidden'); assert.equal(hiddenState.opacity, 0);
    assert.equal(hiddenState.pressed, 'true'); assert.equal(hiddenState.pressedMenu, 'true'); assert.equal(hiddenState.checked, true);
    assert.equal(hiddenState.barInert, true);
    evidence.fade = { out, hiddenState };
    const back = await inspectToggle(false, true);
    assert.equal(back.immersive, false); assert.equal(back.switching, true);
    const backOpacity = byProp(back, 'opacity');
    assert.ok(backOpacity.mid && backOpacity.mid.opacity > 0.02 && backOpacity.mid.opacity < 0.98, '淡入中间值: ' + JSON.stringify(backOpacity.mid));
    assert.ok(back.delaySpec.trim().endsWith('0s'), '淡入 visibility 不延迟: ' + back.delaySpec);
    await settled();
    const shownState = await probe();
    assert.equal(shownState.visibility, 'visible'); assert.equal(shownState.opacity, 1);
    assert.equal(shownState.pressed, 'false'); assert.equal(shownState.checked, false); assert.equal(shownState.barInert, false);
    assert.equal(shownState.focus, 'sp-stage-immersive', '退出沉浸焦点回到触发按钮');
    assert.equal(shownState.animations, 0, '落定后无残留过渡');
    evidence.fade.back = back;
    pass('fade 双向平滑： visibility 延迟、中间值、aria/inert/焦点/歌词画布排除全部一致');

    // 4. 设置面板真实路径改类型：即改即生效（不用切换就写 dataset），翻转有真实 rotate
    await openDisplayTab();
    await page.screenshot({ path: path.join(output, 'display-tab.png') });
    await page.locator('#sp-immersive-fx').selectOption('flip');
    assert.equal((await probe()).fx, 'flip', '类型改动立即写入 data-imm-fx');
    assert.equal(await page.evaluate(() => Space3D.preferences().immersiveFx), 'flip');
    await closeSheet();
    const flip = await inspectToggle(true, true);
    const flipRotate = byProp(flip, 'rotate');
    assert.ok(flipRotate, '翻转产生 rotate 过渡');
    assert.ok(flipRotate.keyframes.some(k => k.rotate && k.rotate.includes('88deg')), '翻转关键帧到 x 88deg: ' + JSON.stringify(flipRotate.keyframes));
    assert.ok(flipRotate.mid && flipRotate.mid.rotate !== 'none' && flipRotate.mid.rotate.includes('x'), '翻转中间值: ' + JSON.stringify(flipRotate.mid));
    await settled(); await inspectToggle(false, false); await settled();
    assert.equal((await probe()).immersive, false, 'flip 退出后回到正常模式');
    evidence.flip = flipRotate;
    pass('显示 tab 真实下拉改 flip 立即生效，切换有透视翻转关键帧与中间值');

    // 5. zoom / slide 预设（configure 外部路径同样立即生效）
    await page.evaluate(() => Space3D.configure({ immersiveFx: 'zoom' }));
    const zoom = await inspectToggle(true, true);
    const zoomScale = byProp(zoom, 'scale');
    assert.ok(zoomScale && zoomScale.keyframes.some(k => k.scale === '0.9'), '缩放关键帧到 0.9: ' + JSON.stringify(zoomScale && zoomScale.keyframes));
    assert.ok(zoomScale.mid && Number(zoomScale.mid.scale) < 0.999 && Number(zoomScale.mid.scale) > 0.89, '缩放中间值: ' + JSON.stringify(zoomScale.mid));
    await settled(); await inspectToggle(false, false); await settled();
    await page.evaluate(() => Space3D.configure({ immersiveFx: 'slide' }));
    const slide = await inspectToggle(true, true);
    const slideTranslate = byProp(slide, 'translate');
    assert.ok(slideTranslate && slideTranslate.keyframes.some(k => k.translate === '0px 28px'), '滑动关键帧到 28px: ' + JSON.stringify(slideTranslate && slideTranslate.keyframes));
    assert.ok(slideTranslate.mid && parseFloat(slideTranslate.mid.translate.split(' ')[1]) > 0, '滑动中间值: ' + JSON.stringify(slideTranslate.mid));
    await settled(); await inspectToggle(false, false); await settled();
    evidence.zoom = zoomScale; evidence.slide = slideTranslate;
    pass('zoom/scale 与 slide/translate 预设产生真实关键帧与中间值');

    // 6. 时长即改即生效：900ms 与 150ms 两档的过渡时长与落定节奏
    await openDisplayTab();
    await setRange('#sp-immersive-fx-dur', 900);
    assert.equal(await page.locator('#sp-immersive-fx-dur-val').textContent(), '900 ms');
    assert.equal((await probe()).dur, '900ms');
    await closeSheet();
    await page.evaluate(() => Space3D.configure({ immersiveFx: 'fade' }));
    const slow = await inspectToggle(true, false);
    assert.ok(slow.specAtClick.includes('0.9s'), '900ms 规格写入过渡: ' + slow.specAtClick);
    await settled(); assert.equal((await probe()).visibility, 'hidden');
    await inspectToggle(false, false); await settled();
    await page.evaluate(() => Space3D.configure({ immersiveFxDur: 150 }));
    const fast = await inspectToggle(true, false);
    assert.ok(fast.specAtClick.includes('0.15s'), '150ms 规格写入过渡: ' + fast.specAtClick);
    await page.waitForTimeout(400);
    const fastSettled = await probe();
    assert.equal(fastSettled.switching, false, '150ms 档 400ms 内已落定');
    assert.equal(fastSettled.visibility, 'hidden');
    await inspectToggle(false, false); await settled();
    evidence.duration = { slow: slow.specAtClick, fast: fast.specAtClick };
    pass('时长滑杆即改即生效：900ms/150ms 规格与落定节奏随档走');

    // 7. 关闭动画：无 switching class，双向立即到位；滑杆禁用
    await openDisplayTab();
    await page.locator('#sp-immersive-fx').selectOption('off');
    assert.equal(await page.locator('#sp-immersive-fx-dur').isDisabled(), true, '关闭动画后时长滑杆禁用');
    await closeSheet();
    const offOut = await inspectToggle(true, false);
    assert.equal(offOut.switching, false); assert.equal(offOut.immersive, true);
    assert.equal((await probe()).visibility, 'hidden', '关闭动画立即隐藏');
    await inspectToggle(false, false);
    const offIn = await probe();
    assert.equal(offIn.switching, false); assert.equal(offIn.visibility, 'visible', '关闭动画立即恢复');
    assert.equal(offIn.opacity, 1);
    pass('关闭动画：双向立即到位，无切换 class，滑杆禁用');

    // 8. 系统减弱动态：即使开着动画也立即到位
    await page.evaluate(() => Space3D.configure({ immersiveFx: 'flip', immersiveFxDur: 900 }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedOut = await inspectToggle(true, false);
    assert.equal(reducedOut.switching, false); assert.equal((await probe()).visibility, 'hidden');
    await inspectToggle(false, false);
    assert.equal((await probe()).visibility, 'visible');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    pass('prefers-reduced-motion 下动画自动关闭');

    // 9. 快速连切：1200ms 档中途反复反转，过渡重定向不叠加，终态一致
    await page.evaluate(() => Space3D.configure({ immersiveFx: 'flip', immersiveFxDur: 1200 }));
    let maxAnimations = 0;
    for (let i = 0; i < 6; i++) {
      const report = await inspectToggle(i % 2 === 0, false);
      maxAnimations = Math.max(maxAnimations, report.captured.length);
      await page.waitForTimeout(120);
    }
    assert.ok(maxAnimations >= 1 && maxAnimations <= 6, '在飞过渡有界不叠加: ' + maxAnimations);
    await settled();
    const rapidEnd = await probe();
    assert.equal(rapidEnd.immersive, false); assert.equal(rapidEnd.switching, false);
    assert.equal(rapidEnd.opacity, 1); assert.equal(rapidEnd.visibility, 'visible');
    assert.equal(rapidEnd.rotate, 'none'); assert.equal(rapidEnd.scale, 'none'); assert.equal(rapidEnd.translate, 'none');
    assert.equal(rapidEnd.animations, 0); assert.equal(rapidEnd.barInert, false);
    assert.equal(rapidEnd.pressed, 'false'); assert.equal(rapidEnd.checked, false);
    evidence.rapid = { maxAnimations, rapidEnd };
    pass('快速连切 6 次：过渡数有界、终态无残留');

    // 10. 在飞中外部改设置：立即落终态，下一拍用新参数
    await inspectToggle(true, false);
    assert.equal((await probe()).switching, true);
    await page.evaluate(() => Space3D.configure({ immersiveFxDur: 150 }));
    const snapped = await probe();
    assert.equal(snapped.switching, false, '在飞中改设置立即落终态');
    assert.equal(snapped.immersive, true); assert.equal(snapped.visibility, 'hidden');
    await inspectToggle(false, false); await settled();
    assert.equal((await probe()).opacity, 1);
    pass('在飞中外部改设置立即落终态且状态一致');

    // 11. 归一化：非法值回退、部分 configure 不清掉已设值
    const sanitized = await page.evaluate(() => {
      Space3D.configure({ immersiveFx: 'bogus', immersiveFxDur: 99999 });
      const a = { fx: Space3D.preferences().immersiveFx, dur: Space3D.preferences().immersiveFxDur };
      Space3D.configure({ immersiveFxDur: 'fast' });
      const b = Space3D.preferences().immersiveFxDur;
      Space3D.configure({ immersiveFx: 'zoom' });
      Space3D.configure({ cinema: false });
      return { a, b, kept: Space3D.preferences().immersiveFx };
    });
    assert.deepEqual(sanitized.a, { fx: 'fade', dur: 1200 });
    assert.equal(sanitized.b, 450);
    assert.equal(sanitized.kept, 'zoom', '部分 configure 保留已设动画类型');
    pass('非法类型/时长归一化回退，部分 configure 不清字段');

    // 12. 恢复空间默认：回到 fade/450 且控件同步
    await openDisplayTab();
    await page.locator('#sp-defaults').click();
    const defaults = await page.evaluate(() => ({ fx: Space3D.preferences().immersiveFx, dur: Space3D.preferences().immersiveFxDur,
      select: document.getElementById('sp-immersive-fx').value, range: document.getElementById('sp-immersive-fx-dur').value,
      output: document.getElementById('sp-immersive-fx-dur-val').textContent }));
    assert.deepEqual(defaults, { fx: 'fade', dur: 450, select: 'fade', range: '450', output: '450 ms' });
    await closeSheet();
    await page.waitForFunction(() => Space3D.stats().state.state === 'ready', null, { timeout: 120000 });
    pass('恢复空间默认把动画带回 fade/450 并同步控件');

    // 13. 既有动效不被接管：播放条自动隐藏与弹层开合规格保持原样
    await page.evaluate(() => Space3D.configure({ immersiveFxDur: 900, playerAutoHide: true }));
    const barBox = await page.locator('#sp-bar').boundingBox();
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await page.mouse.move(720, 300);
    await page.waitForFunction(() => document.getElementById('space3d').classList.contains('sp-player-hidden'), null, { timeout: 6000 });
    await page.mouse.move(720, 890);
    await page.waitForFunction(() => !document.getElementById('space3d').classList.contains('sp-player-hidden'), null, { timeout: 6000 });
    const restored = await probe();
    assert.ok(!restored.transitionDuration.includes('0.9s'), '自动隐藏恢复后仍是播放条自己的时长: ' + restored.transitionDuration);
    await page.locator('#sp-more').click();
    await page.waitForFunction(() => document.getElementById('sp-player-options').classList.contains('sp-show'));
    const popoverDuration = await page.locator('#sp-player-options').evaluate(el => getComputedStyle(el).transitionDuration);
    assert.ok(!popoverDuration.includes('0.9s'), '弹层开合仍是自己的时长: ' + popoverDuration);
    await page.keyboard.press('Escape');
    await page.evaluate(() => Space3D.configure({ playerAutoHide: false }));
    pass('播放条自动隐藏与弹层开合的既有过渡规格不被沉浸时长接管');

    // 14. 持久化：UI 改动落库，reload 后 prefs 与控件恢复
    await openDisplayTab();
    await page.locator('#sp-immersive-fx').selectOption('slide');
    await setRange('#sp-immersive-fx-dur', 600);
    await closeSheet();
    await page.waitForTimeout(800);
    const saved = (await preview.fixture.api('/v1/settings')).space3d;
    assert.equal(saved.immersiveFx, 'slide'); assert.equal(saved.immersiveFxDur, 600);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && Space3D.preferences().immersiveFx === 'slide' && Space3D.preferences().immersiveFxDur === 600, null, { timeout: 30000 });
    const restoredPrefs = await page.evaluate(() => ({ select: document.getElementById('sp-immersive-fx').value,
      range: document.getElementById('sp-immersive-fx-dur').value, output: document.getElementById('sp-immersive-fx-dur-val').textContent,
      fx: document.getElementById('space3d').dataset.immFx, dur: document.getElementById('space3d').style.getPropertyValue('--sp-imm-dur') }));
    assert.deepEqual(restoredPrefs, { select: 'slide', range: '600', output: '600 ms', fx: 'slide', dur: '600ms' });
    evidence.persistence = { saved: { fx: saved.immersiveFx, dur: saved.immersiveFxDur }, restoredPrefs };
    pass('设置经 PUT /v1/settings 落库，reload 后 prefs/控件/变量全恢复');

    assert.deepEqual(errors, [], 'no page errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: true, checks, evidence }, null, 2));
    console.log('\nImmersive fx: ' + checks.length + ' journeys passed');
  } catch (error) {
    try { fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: false, checks, evidence, failure: String(error && error.message || error), pageErrors: errors }, null, 2)); } catch (_) { /* artifact failure must not replace the original */ }
    if (errors.length) console.error('Page errors: ' + JSON.stringify(errors));
    throw error;
  } finally {
    await browser.close(); await preview.close();
  }
}
run().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });