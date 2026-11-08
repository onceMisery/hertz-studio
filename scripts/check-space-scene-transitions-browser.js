#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Space3D 舞台场景切换转场：类型/时长接线、遮罩阶段、连续切换终态、程序化瞬切、
// reduced/低画质降级、设置落库与 reload。自起隔离夹具 + node 代理回源磁盘 UI。
//   PLAYWRIGHT_MODULE=... node scripts/check-space-scene-transitions-browser.js
// --serve 只起预览服务供手工查看。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { startFixture } = require('./ui-browser-fixture');
const web = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/space-scene-transitions');

async function startPreview() {
  const fixture = await startFixture();
  try {
    await fixture.api('/v1/settings', 'PUT', { space3d: { sceneSource: 'coast', qualityMode: 'medium', playerAutoHide: false } });
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

const matrixScale = t => {
  if (!t || t === 'none') return null;
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (m) return parseFloat(m[1].split(',')[0]);
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) return parseFloat(m3[1].split(',')[0]);
  return null;
};
const matrixF = t => {
  const m = /^matrix\(([^)]+)\)$/.exec(t || '');
  return m ? parseFloat(m[1].split(',')[5]) : null;
};
const matrixE = t => {
  const m = /^matrix\(([^)]+)\)$/.exec(t || '');
  return m ? parseFloat(m[1].split(',')[4]) : null;
};

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const preview = await startPreview();
  if (process.argv.includes('--serve')) {
    console.log('Scene transition preview: ' + preview.base);
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
    await page.waitForTimeout(300);

    const probe = () => page.evaluate(() => {
      const root = document.getElementById('space3d'), veil = document.getElementById('sp-scene-veil');
      const sheet = veil.querySelector('.sp-veil-sheet');
      return {
        switching: root.classList.contains('sp-scene-switching'),
        phase: veil.dataset.phase, direction: veil.dataset.sceneDirection,
        fx: root.dataset.sceneFx, durVar: root.style.getPropertyValue('--sp-scene-fx-dur'),
        sheetOpacity: Number(getComputedStyle(sheet).opacity),
        veilVisibility: getComputedStyle(veil).visibility,
        canvasTransform: getComputedStyle(document.getElementById('sp-canvas')).transform,
        source: Space3D.sourceId(), transition: Space3D.sceneTransition(),
      };
    });
    const settle = async () => {
      await page.waitForFunction(() => !document.getElementById('space3d').classList.contains('sp-scene-switching') &&
        Space3D.sceneTransition().phase === 'idle', null, { timeout: 40000 });
    };
    const resetLog = () => page.evaluate(() => { window.__sceneFxLog.length = 0; });
    const readLog = () => page.evaluate(() => window.__sceneFxLog.slice());
    const clickCard = label => page.locator('#sp-fx-grid button').filter({ hasText: label }).first().click();
    const phaseEntries = log => log.filter(e => e.kind === 'phase');
    const sampleOf = (log, phase) => log.find(e => e.kind === 'sample' && e.phase === phase);

    // 1. 默认接线
    const startup = await page.evaluate(() => ({ prefs: { fx: Space3D.preferences().sceneFx, dur: Space3D.preferences().sceneFxDur, glide: Space3D.preferences().sceneFxGlide },
      select: document.getElementById('sp-scene-fx').value, range: document.getElementById('sp-scene-fx-dur').value,
      output: document.getElementById('sp-scene-fx-dur-val').textContent, glide: document.getElementById('sp-scene-fx-glide').checked }));
    assert.deepEqual(startup.prefs, { fx: 'veil-fade', dur: 640, glide: true });
    assert.equal(startup.select, 'veil-fade'); assert.equal(startup.range, '640'); assert.equal(startup.output, '640 ms'); assert.equal(startup.glide, true);
    const idleProbe = await probe();
    assert.equal(idleProbe.fx, 'veil-fade'); assert.equal(idleProbe.durVar, '640ms'); assert.equal(idleProbe.switching, false); assert.equal(idleProbe.phase, 'idle');
    evidence.startup = startup;
    pass('缺省 sceneFx=veil-fade/640/glide，控件、data-scene-fx 与 CSS 变量开机同步');

    // 2. 进空间 + 舞台就绪 + 遮罩图层与 DOM 顺序
    await page.evaluate(() => { Space3D.open(); Space3D.enterStage(); });
    await page.waitForFunction(() => Space3D.stats().page === 'stage' && Space3D.stats().state.state === 'ready', null, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById('sp-warp').hidden, null, { timeout: 15000 });
    const layering = await page.evaluate(() => {
      const veil = document.getElementById('sp-scene-veil'), reading = document.getElementById('sp-reading'), canvas = document.getElementById('sp-canvas');
      return { veilZ: getComputedStyle(veil).zIndex, readingZ: getComputedStyle(reading).zIndex,
        pointer: getComputedStyle(veil).pointerEvents, contain: getComputedStyle(veil).contain,
        afterCanvas: !!(canvas.compareDocumentPosition(veil) & Node.DOCUMENT_POSITION_FOLLOWING),
        beforeReading: !!(veil.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING),
        label: veil.querySelector('.sp-veil-label') && veil.querySelector('.sp-veil-label').textContent };
    });
    assert.equal(layering.veilZ, '3'); assert.equal(layering.readingZ, '3');
    assert.equal(layering.pointer, 'none'); assert.equal(layering.contain, 'strict');
    assert.equal(layering.afterCanvas, true); assert.equal(layering.beforeReading, true);
    assert.equal(layering.label, '正在切换场景');
    evidence.layering = layering;

    // 观测器：阶段变化记录时间戳；阶段内 +90ms 取样 computed 值（合成器相位无关）。
    await page.evaluate(() => {
      window.__sceneFxLog = [];
      const veil = document.getElementById('sp-scene-veil'), root = document.getElementById('space3d');
      const canvas = document.getElementById('sp-canvas'), sheet = veil.querySelector('.sp-veil-sheet'), cur = veil.querySelector('.sp-veil-a');
      const sample = delay => setTimeout(() => {
        const canvasStyle = getComputedStyle(canvas), curtainStyle = getComputedStyle(cur);
        window.__sceneFxLog.push({ kind: 'sample', t: Math.round(performance.now()), phase: veil.dataset.phase,
          sheetOpacity: Number(getComputedStyle(sheet).opacity), canvasTransform: canvasStyle.transform,
          canvasSpec: canvasStyle.transitionDuration, curtainTransform: curtainStyle.transform,
          curtainSpec: curtainStyle.transitionDuration });
      }, delay);
      new MutationObserver(() => {
        window.__sceneFxLog.push({ kind: 'phase', phase: veil.dataset.phase, t: Math.round(performance.now()),
          switching: root.classList.contains('sp-scene-switching') });
        // 两个取样点：阶段早期看「起点」，稍后看「进行中」；主线程被饿时晚点那发落在下一阶段。
        if (veil.dataset.phase !== 'idle') { sample(40); sample(140); }
      }).observe(veil, { attributes: true, attributeFilter: ['data-phase'] });
      new MutationObserver(() => {
        if (root.classList.contains('sp-scene-switching')) window.__sceneFxLog.push({ kind: 'switching', t: Math.round(performance.now()) });
      }).observe(root, { attributes: true, attributeFilter: ['class'] });
    });
    pass('遮罩 z3 位于画布之上、歌词与 chrome 之下，pointer-events:none + contain:strict');

    // 3. 打开控制台（stage tab），后续用真实预设卡切场
    await page.locator('#sp-console-toggle').click();
    await page.waitForFunction(() => document.getElementById('sp-sheet').classList.contains('sp-show'));
    assert.ok(await page.locator('#sp-fx-grid button').count() >= 2, '预设卡存在');

    // 4. 五类转场的阶段与容器变换
    const runs = [
      { type: 'veil-fade', target: '星座', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold, 'fade 有 hold 取样: ' + JSON.stringify(log));
        assert.equal(hold.canvasTransform, 'none', 'fade 不动画布');
        assert.equal(hold.sheetOpacity, 1, 'fade hold 全遮');
      } },
      { type: 'zoom', target: '海岸公路', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold, 'zoom 有 hold 取样: ' + JSON.stringify(log));
        const holdScale = matrixScale(hold.canvasTransform);
        assert.ok(holdScale > 1.03 && holdScale < 1.05, 'zoom hold 是无过渡的入场起点(≈1.04): ' + holdScale);
        // 渲染被饿死时过渡时钟不推进，中间帧不可靠；钉过渡规格证明 cover/reveal 段在走。
        assert.ok(log.some(e => e.kind === 'sample' && (e.canvasSpec.includes('0.288s') || e.canvasSpec.includes('0.352s'))), 'zoom 过渡规格 45%/55%: ' + JSON.stringify(log.filter(e => e.kind === 'sample').map(e => e.canvasSpec)));
      } },
      { type: 'tilt', target: '星座', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold && hold.canvasTransform.startsWith('matrix3d('), 'tilt hold 是 3D 变换: ' + (hold && hold.canvasTransform));
        assert.ok(log.some(e => e.kind === 'sample' && (e.canvasSpec.includes('0.288s') || e.canvasSpec.includes('0.352s'))), 'tilt 过渡规格 45%/55%: ' + JSON.stringify(log.filter(e => e.kind === 'sample').map(e => e.canvasSpec)));
      } },
      { type: 'slide', target: '海岸公路', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold && matrixF(hold.canvasTransform) > 0, 'slide hold 自下入场: ' + (hold && hold.canvasTransform));
        assert.ok(log.some(e => e.kind === 'sample' && (e.canvasSpec.includes('0.288s') || e.canvasSpec.includes('0.352s'))), 'slide 过渡规格 45%/55%: ' + JSON.stringify(log.filter(e => e.kind === 'sample').map(e => e.canvasSpec)));
      } },
      { type: 'veil-wipe', target: '星座', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold, 'wipe 有 hold 取样');
        assert.equal(matrixE(hold.curtainTransform), 0, 'wipe hold 帘幕全遮: ' + hold.curtainTransform);
        assert.equal(hold.sheetOpacity, 0, 'wipe 不使用底遮罩');
        assert.ok(log.some(e => e.kind === 'sample' && e.curtainSpec.includes('0.32s')), 'wipe 帘幕过渡规格 50%: ' + JSON.stringify(log.filter(e => e.kind === 'sample').map(e => e.curtainSpec)));
      } },
      { type: 'combo', target: '海岸公路', check: log => {
        const hold = sampleOf(log, 'hold');
        assert.ok(hold && hold.canvasTransform.startsWith('matrix3d('), 'combo hold 是 3D 变换');
        assert.ok(matrixScale(hold.canvasTransform) > 1.01, 'combo hold 带缩放: ' + (hold && hold.canvasTransform));
        assert.ok(log.some(e => e.kind === 'sample' && (e.canvasSpec.includes('0.288s') || e.canvasSpec.includes('0.352s'))), 'combo 过渡规格 45%/55%');
      } },
    ];
    // 注意：不能拿 Space3D.configure({sceneFx}) 改类型——configure 是整对象恢复接口，
    // 缺省 sceneSource 时会按既有语义把场景重置回 coast，导致「切回海岸公路」变同场景 no-op。
    const setType = async type => {
      await page.locator('#sp-tab-display').click();
      await page.locator('#sp-scene-fx').selectOption(type);
      await page.locator('#sp-tab-stage').click();
    };
    for (const item of runs) {
      await setType(item.type);
      await resetLog();
      await clickCard(item.target);
      await settle();
      const log = await readLog();
      const phases = phaseEntries(log).map(e => e.phase);
      for (const step of ['cover', 'hold', 'reveal', 'idle']) assert.ok(phases.includes(step), item.type + ' 阶段序列含 ' + step + ': ' + JSON.stringify(phases));
      assert.equal(await page.evaluate(() => Space3D.sourceId()), item.target === '星座' ? 'zodiac' : 'coast');
      item.check(log);
      evidence[item.type] = { phases, sample: sampleOf(log, 'hold') || sampleOf(log, 'cover') };
      pass('转场 ' + item.type + '：阶段序列 cover→hold→reveal→idle，容器/帘幕变换到位');
    }

    // 5. 同场景重复点击：不重建、不转场
    await setType('veil-fade');
    await resetLog();
    await clickCard('海岸公路');
    await page.waitForTimeout(400);
    assert.equal((await readLog()).filter(e => e.kind === 'switching').length, 0, '同场景重复点击不启动转场');
    assert.equal((await probe()).switching, false);
    pass('同场景重复点击是 no-op（不转场、不重建）');

    // 6. 连续 A→B→C：只认最后一次，终态一致、无残留遮罩
    await resetLog();
    await clickCard('星座');
    await page.waitForTimeout(80);
    await clickCard('海岸公路');
    await page.waitForTimeout(80);
    await clickCard('星座');
    await settle();
    const rapidEnd = await probe();
    assert.equal(rapidEnd.source, 'zodiac'); assert.equal(rapidEnd.switching, false); assert.equal(rapidEnd.phase, 'idle');
    assert.equal(rapidEnd.sheetOpacity, 0, '终态遮罩透明');
    assert.equal(rapidEnd.canvasTransform, 'none', '终态画布无残留变换');
    const rapidPhases = phaseEntries(await readLog()).map(e => e.phase);
    assert.equal(rapidPhases[rapidPhases.length - 1], 'idle');
    evidence.rapid = { phases: rapidPhases, end: rapidEnd };
    pass('连续 A→B→C：只保留最后一次目标，终态无残留'); 

    // 7. 程序化 setSource：不转场
    await resetLog();
    await page.evaluate(() => Space3D.setSource('coast'));
    await page.waitForFunction(() => Space3D.sourceId() === 'coast' && Space3D.stats().state.state === 'ready', null, { timeout: 30000 });
    assert.equal((await readLog()).filter(e => e.kind === 'switching').length, 0, '程序化 setSource 不启动转场');
    assert.equal((await probe()).switching, false);
    pass('程序化 setSource 保持瞬切（不启动遮罩）');

    // 8. reduced-motion：瞬切
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await resetLog();
    await clickCard('星座');
    await page.waitForFunction(() => Space3D.sourceId() === 'zodiac' && Space3D.stats().state.state === 'ready', null, { timeout: 30000 });
    assert.equal((await readLog()).filter(e => e.kind === 'switching').length, 0, 'reduced-motion 下不启动转场');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    pass('prefers-reduced-motion 下场景切换瞬切');

    // 9. 低画质降级：强制 fade、时长封顶 320ms（走真实画质下拉，configure 的 qualityMode 只在同场景时生效）
    await page.locator('#sp-tab-display').click();
    await page.locator('#sp-quality').selectOption('low');
    await page.waitForTimeout(200);
    const degraded = await page.evaluate(() => ({ tr: Space3D.sceneTransition(), q: Space3D.stats().renderer && Space3D.stats().renderer.effectiveQuality }));
    assert.equal(degraded.tr.type, 'veil-fade', '低画质强制 fade: ' + JSON.stringify(degraded));
    assert.ok(degraded.tr.dur <= 320, '低画质时长封顶 320: ' + degraded.tr.dur);
    await page.locator('#sp-quality').selectOption('medium');
    await page.locator('#sp-tab-stage').click();
    pass('低画质自适应降级为 fade 且时长 ≤320ms');

    // 10. 时长接线：920ms 档（滑杆 step=40，900 不在格点上会被浏览器吸附）的规格与阶段节奏
    await setType('veil-fade');
    await page.evaluate(() => {
      const el = document.getElementById('sp-scene-fx-dur');
      el.value = '920'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => Space3D.preferences().sceneFxDur), 920);
    await resetLog();
    await clickCard('海岸公路');
    // rAF 轮询在 swiftshader 下会整段错过 120ms 的 hold；改为等「日志里出现过 hold」这个持久条件。
    await page.waitForFunction(() => window.__sceneFxLog.some(e => e.kind === 'phase' && e.phase === 'hold'), null, { timeout: 30000 });
    const holdProbe = await probe();
    assert.equal(holdProbe.durVar, '920ms');
    await settle();
    const log900 = await readLog();
    const coverAt = phaseEntries(log900).find(e => e.phase === 'cover');
    const revealAt = phaseEntries(log900).find(e => e.phase === 'reveal');
    assert.ok(revealAt && coverAt && revealAt.t - coverAt.t >= 520, '920ms 档 cover→reveal 间隔 ≥520ms: ' + (revealAt && coverAt && revealAt.t - coverAt.t));
    evidence.duration = { durVar: holdProbe.durVar, coverToReveal: revealAt.t - coverAt.t };
    pass('时长滑杆 920ms 接线到遮罩规格与阶段节奏');

    // 10b. 在飞中改设置（真实滑杆事件）：立即收尾、状态一致，不残留遮罩
    // 用 1200ms 长档 + 墙钟 250ms 保证探针确实落在转场中（rAF 等待可能被饿到转场结束）。
    await page.evaluate(() => {
      const el = document.getElementById('sp-scene-fx-dur');
      el.value = '1200'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await resetLog();
    await clickCard('星座');
    await page.waitForTimeout(120);
    // 派发 input 与读取收尾状态放在同一任务里：不依赖计时器落点。
    const snapped = await page.evaluate(() => {
      const before = Space3D.sceneTransition().phase;
      const el = document.getElementById('sp-scene-fx-dur');
      el.value = '240'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return { before, after: Space3D.sceneTransition().phase,
        switching: document.getElementById('space3d').classList.contains('sp-scene-switching'),
        veilVisibility: getComputedStyle(document.getElementById('sp-scene-veil')).visibility };
    });
    assert.ok(['cover', 'hold', 'reveal'].includes(snapped.before), '改设置前必须处于转场中: ' + snapped.before);
    assert.equal(snapped.switching, false, '在飞中改设置立即收尾');
    assert.equal(snapped.after, 'idle');
    assert.equal(snapped.veilVisibility, 'hidden', '收尾后遮罩不再可见');
    await page.waitForFunction(() => Space3D.sourceId() === 'zodiac' && Space3D.stats().state.state === 'ready', null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const afterSnap = await probe();
    assert.equal(afterSnap.switching, false, '收尾后不复发');
    assert.ok(afterSnap.sheetOpacity < 0.001, '收尾后遮罩不透明度归零: ' + afterSnap.sheetOpacity);
    evidence.midFlightSettings = snapped;
    pass('在飞中改设置立即收尾且状态一致');

    // 11. 设置 UI 落库 + reload 恢复
    await page.locator('#sp-tab-display').click();
    await page.locator('#sp-scene-fx').selectOption('tilt');
    await page.locator('#sp-scene-fx-dur').evaluate(el => { el.value = '880'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#sp-scene-fx-glide').uncheck();
    await page.waitForTimeout(900);
    const saved = (await preview.fixture.api('/v1/settings')).space3d;
    assert.equal(saved.sceneFx, 'tilt'); assert.equal(saved.sceneFxDur, 880); assert.equal(saved.sceneFxGlide, false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && Space3D.preferences().sceneFx === 'tilt' && Space3D.preferences().sceneFxDur === 880 && Space3D.preferences().sceneFxGlide === false, null, { timeout: 30000 });
    const restoredPrefs = await page.evaluate(() => ({ select: document.getElementById('sp-scene-fx').value,
      range: document.getElementById('sp-scene-fx-dur').value, output: document.getElementById('sp-scene-fx-dur-val').textContent,
      fx: document.getElementById('space3d').dataset.sceneFx, dur: document.getElementById('space3d').style.getPropertyValue('--sp-scene-fx-dur'),
      glide: document.getElementById('sp-scene-fx-glide').checked }));
    assert.deepEqual(restoredPrefs, { select: 'tilt', range: '880', output: '880 ms', fx: 'tilt', dur: '880ms', glide: false });
    evidence.persistence = { saved: { fx: saved.sceneFx, dur: saved.sceneFxDur, glide: saved.sceneFxGlide }, restoredPrefs };
    pass('设置经 PUT /v1/settings 落库，reload 后类型/时长/滑移全恢复');

    // 12. 既有沉浸切换动画不回归（轻量冒烟）
    await page.evaluate(() => { Space3D.open(); Space3D.enterStage(); });
    await page.waitForFunction(() => Space3D.stats().page === 'stage' && Space3D.stats().state.state === 'ready', null, { timeout: 120000 });
    await page.locator('#sp-stage-immersive').click();
    await page.waitForFunction(() => document.getElementById('space3d').classList.contains('sp-immersive'), null, { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('space3d').classList.contains('sp-immersive'), null, { timeout: 10000 });
    pass('既有沉浸模式开合不受场景转场影响');

    assert.deepEqual(errors, [], 'no page errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: true, checks, evidence }, null, 2));
    console.log('\nScene transitions: ' + checks.length + ' journeys passed');
  } catch (error) {
    try { fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: false, checks, evidence, failure: String(error && error.message || error), pageErrors: errors }, null, 2)); } catch (_) { /* artifact failure must not replace the original */ }
    if (errors.length) console.error('Page errors: ' + JSON.stringify(errors));
    throw error;
  } finally {
    await browser.close(); await preview.close();
  }
}
run().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });