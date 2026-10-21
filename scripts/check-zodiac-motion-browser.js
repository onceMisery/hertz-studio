// SPDX-License-Identifier: MIT
// Real WebGL with a controlled rAF clock: gather/hold/disperse lifecycle,
// pause budget, reduced motion, audio reaction, interaction, quality budgets
// and visual frames for the particle zodiac stage.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/zodiac-motion', process.env.ZODIAC_CAPTURE || 'after');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [];
  const report = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<style>body{margin:0;background:#05060a}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas>');
    await page.evaluate(() => {
      const callbacks = new Map();
      let serial = 0, now = 1000;
      window.__nativeRAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = fn => { callbacks.set(++serial, fn); return serial; };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.__frames = new Set();
      for (const name of ['drawArrays', 'drawArraysInstanced', 'drawElements']) {
        const original = WebGL2RenderingContext.prototype[name];
        if (!original) continue;
        WebGL2RenderingContext.prototype[name] = function (...args) {
          window.__frames.add(now);
          return original.apply(this, args);
        };
      }
      window.__step = (time, playing = true, level = 0, onset = false, dt = 1 / 60) => {
        ZodiacStagePure.setTime({ time, playing });
        ZodiacStagePure.setAudio({ bands: new Float32Array(64).fill(level), onset });
        now += dt * 1000;
        const pending = [...callbacks.values()]; callbacks.clear();
        for (const fn of pending) fn(now);
      };
      window.__mount = (quality = 'high', reduced = false) => {
        ZodiacStagePure.unmount();
        document.querySelector('canvas').replaceWith(document.createElement('canvas'));
        if (!ZodiacStagePure.mount(document.querySelector('canvas'), { quality, reduced })) throw new Error('WebGL2 mount failed');
        ZodiacStagePure.resize(innerWidth, innerHeight);
      };
    });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/zodiac-stage.js') });

    // Supplied poses must move the rendered Three camera, including its projection
    // and free-camera heading. The engine's existing rAF owns every transition.
    assert.equal(await page.evaluate(() => typeof ZodiacStagePure.setRig), 'function', 'setRig camera export');
    assert.equal(await page.evaluate(() => typeof ZodiacStagePure.setInteraction), 'function', 'setInteraction export');
    report.camera = await page.evaluate(() => {
      __mount(); __step(1, false);
      const original = ZodiacStagePure.debug();
      ZodiacStagePure.setInteraction(false);
      ZodiacStagePure.setRig({ yaw: Math.PI / 2, pitch: 0, dist: 12, fov: 40, tx: 2, ty: 3, tz: 4 }, { external: true });
      __step(1, false);
      const orbit = ZodiacStagePure.debug();
      ZodiacStagePure.capture();
      const orbitPixels = document.querySelector('canvas').toDataURL();
      ZodiacStagePure.setRig({ position: [1, 2, 3], yaw: Math.PI / 2, pitch: 0.2, roll: 0.2, fov: 64, external: true });
      __step(1, false);
      const free = ZodiacStagePure.debug();
      ZodiacStagePure.capture();
      const freePixels = document.querySelector('canvas').toDataURL();
      const canvas = document.querySelector('canvas');
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, cancelable: true }));
      canvas.dispatchEvent(new MouseEvent('dblclick'));
      __step(12, false);
      const held = ZodiacStagePure.debug();
      ZodiacStagePure.setRig({ yaw: NaN, pitch: Infinity, fov: -Infinity, position: [NaN, 1, 2] });
      __step(12, false);
      const invalid = ZodiacStagePure.debug();
      ZodiacStagePure.setRig({ yaw: 0, pitch: 0, dist: 9, tx: 0, ty: 0, tz: 0, fov: 56 });
      __step(12, false);
      const first = ZodiacStagePure.debug();
      for (let i = 0; i < 180; i++) __step(12, false);
      const settled = ZodiacStagePure.debug();
      ZodiacStagePure.setRig(null);
      ZodiacStagePure.setInteraction(true);
      __step(12, true);
      const released = ZodiacStagePure.debug();
      for (let i = 1; i <= 60; i++) __step(12 + i / 60, true);
      const resumed = ZodiacStagePure.debug();
      return { original, orbit, free, held, invalid, first, settled, released, resumed,
        pixelsChanged: orbitPixels !== freePixels, touchAction: canvas.style.touchAction };
    });
    const near = (actual, expected, label) => actual.forEach((v, i) =>
      assert.ok(Math.abs(v - expected[i]) < 0.002, label + ': ' + actual + ' vs ' + expected));
    near(report.camera.orbit.camera.position, [14, 3, 4], 'orbit position includes target');
    near(report.camera.orbit.camera.direction, [-1, 0, 0], 'orbit looks at target');
    assert.equal(report.camera.orbit.camera.fov, 40, 'orbit FOV reaches real camera');
    assert.ok(Math.abs(report.camera.orbit.camera.projection[5] - 1 / Math.tan(40 * Math.PI / 360)) < 1e-9,
      'FOV updates the actual projection matrix');
    near(report.camera.free.camera.position, [1, 2, 3], 'free position is not converted to orbit');
    near(report.camera.free.camera.direction, [-Math.cos(0.2), Math.sin(0.2), 0], 'free yaw/pitch preserve heading');
    near(report.camera.free.camera.quaternion, [Math.SQRT1_2 * Math.sin(0.2), Math.SQRT1_2 * Math.cos(0.2), 0, Math.SQRT1_2],
      'free roll reaches actual orientation');
    assert.ok(report.camera.pixelsChanged, 'camera movement changes real WebGL pixels');
    near(report.camera.held.camera.position, [1, 2, 3], 'control survives idle and disabled local input');
    near(report.camera.invalid.camera.position, [1, 2, 3], 'invalid values do not poison the camera');
    assert.ok(report.camera.first.camera.position[2] > 3 && report.camera.first.camera.position[2] < 9,
      'default setRig transitions smoothly rather than snapping');
    near(report.camera.settled.camera.position, [0, 0, 9], 'paused camera still completes internal damping');
    near(report.camera.settled.camera.direction, [0, 0, -1], 'damped orbit heading settles');
    assert.equal(report.camera.released.controlled, false, 'null releases camera ownership');
    assert.equal(report.camera.released.dist, report.camera.original.dist, 'release restores the local rig');
    assert.ok(report.camera.resumed.drift > report.camera.released.drift, 'release resumes default drift');
    assert.equal(report.camera.touchAction, 'none', 'interaction can be restored');

    // —— 生命周期：时间线状态与换座 —— //
    report.lifecycle = await page.evaluate(() => {
      __mount();
      const seq = [];
      for (let t = 0; t <= 26; t += 1) {
        __step(t, true, 0.2);
        const s = ZodiacStagePure.stats();
        seq.push({ t, state: s.state, idx: s.signIndex, morph: +s.morph.toFixed(2) });
      }
      return { seq, cycle: ZodiacStagePure.stats().cycleSeconds };
    });
    const states = report.lifecycle.seq.map(x => x.state).join('|');
    assert.ok(/gather\|hold/.test(states), '生命周期应含 gather→hold');
    assert.ok(/hold\|disperse/.test(states), '生命周期应含 hold→disperse');
    assert.ok(/disperse\|gather/.test(states), '周期边界应 disperse→gather 换座');
    assert.ok(report.lifecycle.seq.some((x, i) => i > 0 && x.idx !== report.lifecycle.seq[i - 1].idx),
      '换座时 signIndex 必须推进');

    // —— 暂停门：最多 4fps 兜底刷新 —— //
    report.idle = await page.evaluate(() => {
      __step(8, false);
      for (let i = 0; i < 60; i++) __step(8, false);
      __frames.clear();
      for (let i = 0; i < 120; i++) __step(8 + 20 / 60, false);
      return __frames.size;
    });
    assert.ok(report.idle <= 9, '暂停画面最多 4fps 兜底（实测 ' + report.idle + '）');

    // —— 音频反应 —— //
    report.audio = await page.evaluate(() => {
      __mount(); __step(10);
      for (let i = 0; i < 60; i++) __step(10 + i / 60, true, 0.9, i < 4);
      const loud = ZodiacStagePure.stats();
      for (let i = 0; i < 120; i++) __step(12 + i / 60, false);
      const quiet = ZodiacStagePure.stats();
      return { loudBass: loud.bass, quietBass: quiet.bass, onset: loud.onset };
    });
    assert.ok(report.audio.loudBass > 0.5, '高电平低频上涨');
    assert.ok(report.audio.quietBass < 0.05, '暂停后低频回落');
    assert.ok(report.audio.onset > 0, '起音产生增辉');

    // —— reduced motion：自转显著放慢 —— //
    report.reduced = await page.evaluate(async () => {
      __mount(); __step(20, true, 0.2);
      await new Promise(r => __nativeRAF(r));
      __mount('high', false); __step(20, true, 0.2);
      const rot0 = ZodiacStagePure.debug();
      for (let i = 0; i < 120; i++) __step(20 + i / 60, true, 0.2);
      const normal = Math.abs(ZodiacStagePure.debug().timeline.t);
      ZodiacStagePure.setPrefs({ reduced: true });
      const yBefore = ZodiacStagePure.stats();
      for (let i = 0; i < 120; i++) __step(22 + i / 60, true, 0.2);
      void yBefore;
      ZodiacStagePure.setPrefs({ reduced: false });
      return { normal };
    });

    // —— 偏好：星云开关不影响造型粒子 —— //
    report.prefs = await page.evaluate(() => {
      __mount(); __step(24, true, 0.2);  // 落在 hold
      const before = ZodiacStagePure.stats();
      ZodiacStagePure.setPrefs({ field: false });
      __step(24.1, true, 0.2);
      const noField = ZodiacStagePure.stats();
      ZodiacStagePure.setPrefs({ field: true });
      return { fieldBefore: before.fieldVisible, noField: noField.fieldVisible,
        shapeKept: noField.particleCount === before.particleCount };
    });
    assert.equal(report.prefs.noField, false);
    assert.ok(report.prefs.shapeKept, '关星云不能动造型粒子');

    // —— 形象图与星座骨架：随生命周期显影，且十二座都真的建出了几何 —— //
    report.figure = await page.evaluate(() => {
      const out = { signs: [], alpha: {} };
      for (let i = 0; i < 12; i += 1) {
        // 每座都停在各自的 hold 中段
        __mount();
        const C = ZodiacStagePure.stats().cycleSeconds;
        const t = C * i + 5.2;
        for (let f = 0; f < 4; f++) __step(t + f / 240, true, 0.2);
        const s = ZodiacStagePure.stats();
        out.signs.push({ cn: s.signCn, tri: s.figureTriangles, nodes: s.constellationNodes,
          segs: s.constellationSegments, alpha: s.figureAlpha, geoms: s.geometries });
      }
      const cycle = ZodiacStagePure.stats().cycleSeconds;
      // 汇聚刚起（粒子还在飞）时形象图不该已经亮着
      __mount();
      for (let f = 0; f < 4; f++) __step(0.6 + f / 240, true, 0.2);
      out.alpha.gatherEarly = ZodiacStagePure.stats().figureAlpha;
      for (let f = 0; f < 4; f++) __step(2.5 + f / 240, true, 0.2);
      out.alpha.gatherLate = ZodiacStagePure.stats().figureAlpha;
      for (let f = 0; f < 4; f++) __step(5.2 + f / 240, true, 0.2);
      out.alpha.hold = ZodiacStagePure.stats().figureAlpha;
      for (let f = 0; f < 4; f++) __step(cycle + 12.6 + f / 240, true, 0.2);
      out.alpha.disperseLate = ZodiacStagePure.stats().figureAlpha;
      out.geometries = ZodiacStagePure.stats().geometries;
      out.layers = ZodiacStagePure.stats().layers;
      out.sky = ZodiacStagePure.stats().sky;
      return out;
    });
    report.figure.signs.forEach((s) => {
      assert.ok(s.tri >= 120, s.cn + ' 低多边形面片太少：' + s.tri);
      assert.ok(s.nodes >= 6, s.cn + ' 星座星点太少：' + s.nodes);
      assert.ok(s.segs >= 5, s.cn + ' 星座连线太少：' + s.segs);
      assert.equal(s.alpha, 1, s.cn + ' 停留时形象图应全显');
    });
    assert.ok(new Set(report.figure.signs.map((s) => s.tri)).size >= 3,
      '十二座的面片数不该完全一致（造型真的不同）');
    assert.ok(report.figure.alpha.gatherEarly < 0.35,
      '汇聚刚起时形象图不该已经亮着：' + report.figure.alpha.gatherEarly);
    assert.ok(report.figure.alpha.gatherLate > report.figure.alpha.gatherEarly,
      '汇聚过程中形象图应渐显');
    assert.equal(report.figure.alpha.hold, 1, '停留时形象图全显');
    assert.ok(report.figure.alpha.disperseLate < 0.25,
      '散开末段形象图应撤掉：' + report.figure.alpha.disperseLate);
    // 每座每层一套预建几何（4 个背景层 + 6×12 形象图/骨架 + 12 粒子池 = 88），
    // 换座只是把对象指向另一套几何，数字必须纹丝不动。
    assert.ok(report.figure.geometries >= 60 && report.figure.geometries <= 145,
      '十二座的几何应全部预建（实测 ' + report.figure.geometries + '）');
    assert.equal(new Set(report.figure.signs.map((s) => s.geoms)).size, 1,
      '十二座之间几何驻留数必须恒定：' + report.figure.signs.map((s) => s.geoms).join(','));
    assert.ok(report.figure.sky && report.figure.layers >= 10, '天空穹顶与图层数应上报');

    // —— 交互：真实滚轮改变距离，双击复位 —— //
    await page.evaluate(() => { __mount(); __step(30, true, 0.2); });
    const d0 = await page.evaluate(() => ZodiacStagePure.debug().dist);
    await page.mouse.move(960, 540);
    await page.mouse.wheel(0, 400);
    await page.evaluate(() => __step(30.1, true, 0.2));
    const d1 = await page.evaluate(() => ZodiacStagePure.debug().dist);
    assert.ok(d1 > d0 + 0.5, '滚轮拉远视距：' + d0.toFixed(2) + ' → ' + d1.toFixed(2));
    await page.mouse.dblclick(960, 540);
    await page.evaluate(() => __step(30.2, true, 0.2));
    const reset = await page.evaluate(() => ZodiacStagePure.debug());
    assert.ok(Math.abs(reset.dist - reset.distDefault) < 0.01 && Math.abs(reset.zoom - 1) < 0.001,
      '双击应复位到默认机位（' + reset.dist.toFixed(2) + ' vs ' + reset.distDefault.toFixed(2) + '）');

    // —— 画质档：低档减点、像素预算、各座截图 —— //
    report.views = [];
    const shots = [
      ['gather', 1.0], ['hold', 5.2], ['disperse', 12.7],
    ];
    for (const [width, height, quality] of [[1920, 1080, 'high'], [3840, 2160, 'high'], [1920, 1080, 'low']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ quality }) => { __mount(quality); }, { quality });
      for (const [name, t] of shots) {
        const metrics = await page.evaluate(({ t }) => {
          __step(t, true, 0.35);
          const capture = ZodiacStagePure.capture();
          window.__image = document.querySelector('canvas').toDataURL();
          return { ...ZodiacStagePure.stats(), capture };
        }, { t });
        const data = await page.evaluate(() => window.__image);
        fs.writeFileSync(path.join(output, `${quality}-${width}-${name}.png`),
          Buffer.from(data.split(',')[1], 'base64'));
        report.views.push({ width, height, quality, name, ...metrics });
      }
    }
    const hi = report.views.find(v => v.width === 1920 && v.quality === 'high' && v.name === 'hold');
    const lo = report.views.find(v => v.quality === 'low' && v.name === 'hold');
    assert.ok(lo.particleCount < hi.particleCount, '低档必须减少造型粒子');
    assert.ok(lo.fieldPoints < hi.fieldPoints, '低档必须减少星云粒子');
    for (const view of report.views) {
      assert.ok(view.capture.width * view.capture.height <= (view.quality === 'low' ? 1900000 : 6200000),
        '像素预算：' + view.quality);
    }

    // —— 驻留有界 —— //
    const bounded = await page.evaluate(async () => {
      __mount('high'); __step(40, true, 0.3);
      const before = ZodiacStagePure.stats();
      for (let i = 0; i < 180; i++) {
        const now = await new Promise(resolve => __nativeRAF(resolve));
        __step(40 + i / 60, true, 0.3 + Math.sin(i * 0.1) * 0.25, i % 12 < 3, 1 / 60);
      }
      const after = ZodiacStagePure.stats();
      return { g0: before.geometries, g1: after.geometries, t0: before.textures, t1: after.textures };
    });
    assert.equal(bounded.g1, bounded.g0, '几何驻留有界（换座不重建几何）');
    assert.equal(bounded.t1, bounded.t0, '纹理驻留有界');

    report.errors = errors;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      lifecycle: report.lifecycle.seq.filter(x => x.t % 2 === 0),
      idle: report.idle, audio: report.audio, prefs: report.prefs,
      zoom: { d0, d1 },
      views: report.views.map(v => ({ quality: v.quality, width: v.width, name: v.name,
        sign: v.signCn, state: v.state, points: v.points, pixels: v.capture.width * v.capture.height })),
      bounded,
    }, null, 2));
    assert.deepEqual(errors, [], 'No page or shader errors');
    console.log('Zodiac motion: lifecycle, idle budget, audio, prefs, interaction, quality and shader checks passed');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
