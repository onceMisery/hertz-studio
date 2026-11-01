#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// P0-02/P0-05 浏览器级行为检查：壁纸页在真实渲染下的时钟分离、整数分频门与
// zodiac 外部时钟模式。运行前需 node tools/build-stages.mjs；playwright 通过
// PLAYWRIGHT_MODULE 提供（与 check-desktop-settings-native.js 相同约定）。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-clock');

function snapshot(playing, seq) {
  const bands = Array.from({ length: 64 }, (_, i) => (playing ? 0.25 + 0.2 * Math.abs(Math.sin(i + seq)) : 0));
  return {
    protocol: 1, seq, valid: true, playing,
    positionMs: 1000 + seq * 250, durationMs: 240000,
    server: { session: 'clock-check', edition: 'full', version: '0.0.0' },
    spectrum: { bands, energy: playing ? 0.5 : 0, ageMs: 0 },
    snapshotAgeMs: 0, timing: 'presentation_applied'
  };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => errors.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
    await page.setContent(
      '<html><body style="margin:0;background:#030405"><div id="host" style="width:100vw;height:100vh"></div>' +
      '<script>window.__events=[];window.ipc={postMessage:function(message){window.__events.push(message);}};</script></body></html>'
    );
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/zodiac-stage.js') });
    await page.addScriptTag({ path: path.join(root, 'crates/hertz-desktop/assets/wallpaper-scene.js') });
    await page.waitForFunction(() => window.__events.some(event => event === 'wallpaper_dom_ready'));

    // 先挂 WebGL 读回钩子（壁纸页自建 canvas，必须赶在 mount 之前）。
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      window.__gl = null;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const result = original.call(this, type, ...args);
        if (/webgl/.test(type) && !window.__gl) window.__gl = result;
        return result;
      };
    });

    await page.evaluate(() => {
      window.hertzWallpaper.applyConfig({
        source: 'fixed', scene: 'zodiac', musicResponse: true,
        brightness: 0.6, motion: 1, quality: 'low', refreshHz: 60,
        allowed: ['zodiac', 'coast', 'butterfly-vortex', 'phoenix-vortex', 'reactor', 'particle-silk', 'gravity-sphere', 'warp-tunnel', 'prism-galaxy'],
      });
      window.hertzWallpaper.applyFeed(null);
      window.hertzWallpaper.start(30);
    });
    await page.waitForFunction(() => window.__events.some(event => event === 'wallpaper_ready'), null, { timeout: 20000 });
    await page.evaluate(s => window.hertzWallpaper.applyFeed(s), snapshot(true, 1));
    await page.waitForFunction(() => {
      const state = window.hertzWallpaper.debug();
      return state.mounted && state.backend === 'zodiac' && state.draws > 10;
    }, null, { timeout: 20000 });

    // 1) 整数分频门：60Hz 下 30fps 目标 → draws ≈ ticks/2；rAF 实际频率以 ticks 计。
    const gate = await page.evaluate(async () => {
      const t0 = performance.now(), d0 = window.hertzWallpaper.debug().draws, k0 = window.hertzWallpaper.debug().ticks;
      await new Promise(resolve => setTimeout(resolve, 2000));
      const t1 = performance.now();
      const d1 = window.hertzWallpaper.debug().draws, k1 = window.hertzWallpaper.debug().ticks;
      return {
        seconds: (t1 - t0) / 1000,
        drawDelta: d1 - d0,
        tickDelta: k1 - k0,
        gate: window.hertzWallpaper.debug().gate,
      };
    });
    assert.ok(gate.tickDelta > 60, `rAF 必须仍在跑（心跳/feed 时效依赖）：ticks=${gate.tickDelta}`);
    const hz = gate.tickDelta / gate.seconds;
    assert.ok(hz > 30, `测试环境 rAF 过慢，无法验证分频：${hz.toFixed(1)}Hz`);
    const expectedDraws = gate.tickDelta / gate.gate.divisor;
    assert.ok(
      Math.abs(gate.drawDelta - expectedDraws) <= expectedDraws * 0.15 + 2,
      `提交次数必须跟随整数分频：draws=${gate.drawDelta} 期望≈${expectedDraws.toFixed(1)} (divisor=${gate.gate.divisor})`,
    );
    assert.ok(Math.abs(gate.gate.budget - 30) < 0.01, `60Hz/30fps 的有效预算应为 30：${gate.gate.budget}`);

    // 2) 真实提交：同一任务内 setTime→render→readPixels。WebGL 默认不保留
    // drawingBuffer，只有紧跟 render 的读回才是有效帧；这同时验证外部时钟合同。
    const pixels = await page.evaluate(() => {
      const read = () => {
        const gl = window.__gl;
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const data = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
        return sum;
      };
      const zodiac = window.ZodiacStagePure || window.HertzStageRuntime.ZodiacStagePure;
      zodiac.setTime({ time: 3.2, playing: true });
      zodiac.render(performance.now());
      const first = read();
      zodiac.setTime({ time: 9.7, playing: true });
      zodiac.render(performance.now());
      const second = read();
      return { first, second };
    });
    assert.ok(pixels.first > 0, '画布不能是纯黑（zodiac 外部时钟必须真实提交）');
    assert.ok(pixels.first !== pixels.second, '画面必须随 sceneTime 变化');

    // 3) P0-02：音乐暂停仍环境运动——playing=false 后 sceneTime 继续推进、bands 衰减到 0。
    await page.evaluate(s => window.hertzWallpaper.applyFeed(s), snapshot(false, 2));
    const paused = await page.evaluate(async () => {
      const s0 = window.hertzWallpaper.debug();
      await new Promise(resolve => setTimeout(resolve, 1000));
      const s1 = window.hertzWallpaper.debug();
      return { sceneDelta: s1.sceneTime - s0.sceneTime, energy: s1.energy, drawsDelta: s1.draws - s0.draws };
    });
    assert.ok(paused.sceneDelta > 800, `音乐暂停后环境时间必须继续推进：${paused.sceneDelta}ms/1s`);
    assert.equal(paused.energy, 0, '暂停后频谱能量必须衰减到 0');
    assert.ok(paused.drawsDelta > 5, '暂停期间提交不应停摆（环境动画仍在渲染）');

    // 4) P0-02/P0-04：motion=0 冻结环境时间；真实媒体时钟独立（positionMs 随
    // 新 feed 快照继续推进——feed 投喂不因 motion=0 停止）。
    await page.evaluate(s => window.hertzWallpaper.applyFeed(s), snapshot(false, 3));
    await page.evaluate(() => window.hertzWallpaper.applyConfig({
      source: 'fixed', scene: 'zodiac', musicResponse: true, brightness: 0.6, motion: 0,
      quality: 'low', refreshHz: 60, allowed: ['zodiac', 'coast'],
    }));
    const frozenStart = await page.evaluate(() => window.hertzWallpaper.debug());
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.evaluate(s => window.hertzWallpaper.applyFeed(s), snapshot(false, 4));
    await new Promise(resolve => setTimeout(resolve, 600));
    const frozenEnd = await page.evaluate(() => window.hertzWallpaper.debug());
    const frozen = {
      sceneDelta: frozenEnd.sceneTime - frozenStart.sceneTime,
      motion: frozenEnd.motion,
      positionDelta: frozenEnd.positionMs - frozenStart.positionMs,
    };
    assert.equal(frozen.motion, 0, 'applyConfig(motion:0) 必须生效');
    assert.ok(frozen.sceneDelta < 50, `motion=0 必须冻结场景时间：${frozen.sceneDelta}ms/1s`);
    assert.ok(frozen.positionDelta > 0, '真实媒体时钟不能被 motion 冻结');

    // 5) 亮度落到宿主 canvas。
    const brightness = await page.evaluate(() => getComputedStyle(document.getElementById('host')).filter);
    assert.ok(brightness.includes('brightness(0.6'), `亮度必须应用到画布：${brightness}`);

    // 6) space 后端回归：换 coast 后门控提交继续。
    await page.evaluate(() => window.hertzWallpaper.applyConfig({
      source: 'fixed', scene: 'coast', musicResponse: true, brightness: 1, motion: 1,
      quality: 'low', refreshHz: 60, allowed: ['zodiac', 'coast'],
    }));
    try {
      await page.waitForFunction(() => {
        const state = window.hertzWallpaper.debug();
        return state.backend === 'space' && state.draws > 5;
      }, null, { timeout: 30000 });
    } catch (failure) {
      const state = await page.evaluate(() => window.hertzWallpaper.debug());
      throw new Error(`space 后端回归失败：${failure.message.split('\n')[0]} state=${JSON.stringify({
        backend: state.backend, scene: state.scene, mounted: state.mounted, draws: state.draws, error: state.error,
      })}`);
    }

    const heartbeats = await page.evaluate(() =>
      window.__events.filter(event => event.startsWith('wallpaper_heartbeat ')).length);
    assert.ok(heartbeats > 3, '心跳必须持续上报（原生以 draws 采样实测帧率）');
    assert.deepEqual(errors, [], '页面不得产生错误');
    console.log(`wallpaper clock checks passed: divisor gate (draws=${gate.drawDelta}/${expectedDraws.toFixed(1)} @${hz.toFixed(0)}Hz), ` +
      `external zodiac pixels ${pixels.first}->${pixels.second}, pause-motion +${paused.sceneDelta}ms/1s, ` +
      `motion=0 frozen +${frozen.sceneDelta}ms/1s, heartbeats=${heartbeats}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exit(1); });
