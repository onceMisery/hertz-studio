'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const web = path.join(__dirname, '../crates/vmusicd/web');
const util = require(path.join(web, 'folia/folia-util.js'));
global.FoliaUtil = util;
const theme = require(path.join(web, 'folia/folia-theme.js'));

function withColors(variables, callback) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = { getComputedStyle: () => ({ getPropertyValue: name => variables[name] || '' }) };
  global.document = { documentElement: {} };
  try { return callback(); }
  finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
}

function luminance(color) {
  const rgb = util.hexToRgb(color);
  const linear = [rgb.r, rgb.g, rgb.b].map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function checkPalette(palette) {
  for (const field of ['backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor', 'tertiaryColor']) {
    assert.match(palette[field], /^#[\da-f]{6}$/i, field);
  }
  assert.ok(contrast(palette.primaryColor, palette.backgroundColor) >= 12, '正文对比度至少 12:1');
  assert.ok(contrast(palette.accentColor, palette.backgroundColor) >= 7, '活动字对比度至少 7:1');
  assert.ok(contrast(palette.tertiaryColor, palette.backgroundColor) >= 4.5, '重音装饰对比度至少 4.5:1');
  assert.ok(contrast(palette.secondaryColor, palette.backgroundColor) >= 4.5, '线稿装饰保持可见');
  assert.equal(new Set([palette.accentColor, palette.secondaryColor, palette.tertiaryColor]).size, 3);
  assert.deepEqual(palette.wordColors, [], '不生成逐字彩虹');
}

function checkResolution() {
  const originalDefault = JSON.stringify(theme.DEFAULT);
  const originalResolved = theme.resolve(1.35);
  const originalSignature = theme.signature(originalResolved);
  const neutral = theme.resolveSonnet(1.35);
  checkPalette(neutral);
  for (const source of ['', '#fff', '#000', '#808080', 'rgb(128, 128, 128)', 'hsl(20 19% 50%)', 'invalid']) {
    withColors({ '--music-highlight': source }, () => {
      assert.deepEqual(theme.resolveSonnet(1.35), neutral, '中性色均有稳定彩色回退');
      assert.deepEqual(theme.resolve(1.35), originalResolved, '保留 classic/cadenza 中性回退');
    });
  }
  const variants = [
    { '--music-highlight': '#3980e8' },
    { '--music-highlight': 'hsl(216 79% 57%)' },
    { '--music-highlight': 'HSL(216, 79%, 57%)' },
    { '--music-highlight': 'rgb(57, 128, 232)' },
    { '--music-highlight-rgb': '57, 128, 232' },
    { '--music-highlight': 'invalid', '--music-highlight-rgb': '57, 128, 232' }
  ];
  for (const variables of variants) {
    withColors(variables, () => {
      const resolved = theme.resolveSonnet(1.35);
      checkPalette(resolved);
      const accent = util.hexToRgb(resolved.accentColor);
      const hue = util.rgbToHsl(accent.r, accent.g, accent.b)[0];
      assert.ok(Math.abs(hue - 216) < 2, '彩色来源保留原色相');
      assert.equal(theme.resolve(1.35).name, 'stage-palette');
    });
  }
  let minimumActiveContrast = Infinity;
  for (let hue = -360; hue <= 720; hue += 3) {
    for (const saturation of [20, 60, 100]) {
      withColors({ '--music-highlight': `hsl(${hue} ${saturation}% 30%)` }, () => {
        const palette = theme.resolveSonnet(1.35);
        checkPalette(palette);
        minimumActiveContrast = Math.min(minimumActiveContrast, contrast(palette.accentColor, palette.backgroundColor));
      });
    }
  }
  for (const [reactivity, intensity] of [[0.5, 'calm'], [1.35, 'normal'], [1.9, 'chaotic']]) {
    assert.equal(theme.resolveSonnet(reactivity).animationIntensity, intensity);
  }
  for (const field of ['backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor', 'tertiaryColor']) {
    assert.notEqual(theme.signature(neutral), theme.signature({ ...neutral, [field]: '#123456' }), field + ' 触发刷新');
  }
  neutral.wordColors.push({ word: '测试', color: '#ffffff' });
  assert.deepEqual(theme.resolveSonnet(1.35).wordColors, []);
  assert.equal(JSON.stringify(theme.DEFAULT), originalDefault);
  assert.deepEqual(theme.resolve(1.35), originalResolved);
  assert.equal(theme.signature(theme.resolve(1.35)), originalSignature);
  console.log('PASS 调色来源、1083 组色相/饱和度、角色分色、签名刷新与旧契约；活动字最低对比 ' + minimumActiveContrast.toFixed(2) + ':1');
}

async function checkBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<style>html,body{margin:0;width:100%;height:100%}#host,.fl-sonnet{position:absolute;inset:0}.fl-sonnet-canvas{position:absolute;inset:0}.fl-sonnet-hot{position:absolute}.fl-sonnet-eyebrow,.fl-sonnet-hud{display:none}</style><div id="host"></div>');
    for (const file of ['vendor/pixi.min.js', 'folia/folia-util.js', 'folia/folia-theme.js', 'folia/folia-sonnet-fx.js']) {
      await page.addScriptTag({ path: path.join(web, file) });
    }
    await page.evaluate(() => {
      const fixture = window.sonnetPaletteFixture = { position: 3200, reduced: false, painted: [] };
      const originalInit = PIXI.Application.prototype.init;
      PIXI.Application.prototype.init = async function (options) {
        fixture.application = this;
        fixture.initOptions = options;
        return originalInit.call(this, options);
      };
      for (const method of ['stroke', 'fill']) {
        const original = PIXI.Graphics.prototype[method];
        PIXI.Graphics.prototype[method] = function (options) {
          if (options && options.color != null) fixture.painted.push(options.color);
          return original.call(this, options);
        };
      }
      fixture.lines = [
        { start_ms: 0, end_ms: 8000, text: '落日把海面染成温柔的金色' },
        { start_ms: 8000, end_ms: 16000, text: '晚风送来一句轻轻的问候' },
        { start_ms: 16000, end_ms: 24000, text: '我们沿着星光继续向前走' }
      ];
      fixture.track = { id: 'palette-check', title: 'Palette check' };
      window.Stage = {
        presentation: () => ({ playing: false, reduced: fixture.reduced, track: fixture.track }),
        position: () => fixture.position,
        lyrics: () => ({ lines: fixture.lines }),
        lyricTokens: line => [{ text: line.text, start_ms: line.start_ms, end_ms: line.end_ms }],
        spectrum: () => [], kick() {}
      };
    });
    await page.addScriptTag({ path: path.join(web, 'folia/folia-sonnet.js') });
    await page.evaluate(() => {
      const fixture = window.sonnetPaletteFixture;
      fixture.renderer = FoliaSonnet.init(document.getElementById('host'));
      fixture.renderer.setTheme(FoliaTheme.resolveSonnet(1.35));
      fixture.renderer.setBgMode('atmosphere');
      fixture.renderer.setVisible(true);
    });
    await page.waitForFunction(() => sonnetPaletteFixture.renderer.getDebugSnapshot().initialized);
    const report = await page.evaluate(() => {
      const fixture = window.sonnetPaletteFixture;
      const renderer = fixture.renderer;
      const application = fixture.application;
      const palette = FoliaTheme.resolveSonnet(1.35);
      const numeric = value => parseInt(value.slice(1), 16);
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const glyphs = () => {
        const nodes = [];
        const visit = node => {
          if (node instanceof PIXI.Text && node.dataset && Number.isFinite(node.dataset.startTime)) nodes.push(node);
          for (const child of node.children || []) visit(child);
        };
        visit(application.stage);
        return nodes;
      };
      const pixels = () => {
        renderer.frame();
        const canvas = document.createElement('canvas');
        canvas.width = application.canvas.width;
        canvas.height = application.canvas.height;
        const context = canvas.getContext('2d');
        context.drawImage(application.canvas, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = 0, visible = 0, colored = 0;
        for (let offset = 0; offset < data.length; offset += 4) {
          const alpha = data[offset + 3];
          if (!alpha) transparent += 1;
          else visible += 1;
          if (alpha > 32 && Math.max(data[offset], data[offset + 1], data[offset + 2])
            - Math.min(data[offset], data[offset + 1], data[offset + 2]) > 35) colored += 1;
        }
        return { transparent: transparent / (data.length / 4), visible, colored, cornerAlpha: data[3] };
      };
      assert(fixture.initOptions.backgroundAlpha === 0, 'Pixi 必须透明初始化');
      renderer.frame();
      assert(glyphs().length > 0, '真实字素已渲染');
      const numericInk = numeric(palette.primaryColor), numericAccent = numeric(palette.accentColor);
      const numericSecondary = numeric(palette.secondaryColor), numericTertiary = numeric(palette.tertiaryColor);
      assert(glyphs().some(node => node.tint === numericAccent), '活动字使用高对比青蓝');
      assert(glyphs().some(node => node.tint === numericInk), '其他字保持统一正文色');
      assert(glyphs().every(node => node.tint === numericInk || node.tint === numericAccent), '歌词没有逐字彩虹');
      for (const color of [numericAccent, numericSecondary, numericTertiary]) {
        assert(fixture.painted.includes(color), '真实图形使用三层调色 ' + color);
      }
      const atmosphere = pixels();
      assert(atmosphere.colored > 100, '氛围模式确实绘出彩色像素');
      const compositions = new Set();
      for (let ordinal = 0; ordinal < 80 && compositions.size < 6; ordinal += 1) {
        fixture.track.id = 'palette-composition-' + ordinal;
        renderer.frame();
        compositions.add(renderer.getDebugSnapshot().composition);
      }
      assert(compositions.size === 6, '保留六种布景');
      const camera = renderer.getDebugSnapshot().camera;
      const composition = renderer.getDebugSnapshot().composition;
      let minimumTransparent = 1;
      for (const layout of ['phrases', 'lines', 'staircase', 'editorial-track']) {
        renderer.setTuning({ lyricLayout: layout });
        renderer.setBgMode('anime');
        for (const reduced of [false, true]) {
          fixture.reduced = reduced;
          for (const eco of [false, true]) {
            renderer.setEco(eco);
            const image = pixels();
            assert(application.stage.filters == null, '图片模式禁用后期填色');
            assert(image.cornerAlpha === 0, '图片模式角落 alpha 为零');
            assert(image.transparent > 0.9, '图片模式至少 90% 像素完全透明');
            assert(image.visible > 100, '图片模式仍绘制歌词');
            assert(!application.stage.children[0].children[0].visible, '图片模式隐藏巨型布景');
            assert(!application.stage.children[0].children[1].visible, '图片模式隐藏 HUD 布景');
            assert(renderer.getDebugSnapshot().retirement.outgoingLayers === 0, '图片模式无残留退场布景');
            minimumTransparent = Math.min(minimumTransparent, image.transparent);
          }
        }
        renderer.setBgMode('atmosphere');
        fixture.reduced = false;
        renderer.setEco(false);
        renderer.frame();
        assert(application.stage.children[0].children[0].visible, '氛围布景可恢复');
      }
      assert(renderer.getDebugSnapshot().camera === camera, '换背景/排版不重抽镜头');
      assert(renderer.getDebugSnapshot().composition === composition, '换背景/排版不重抽布景');
      fixture.painted = [];
      renderer.setTheme({ ...palette, tertiaryColor: '#ffccaa' });
      renderer.frame();
      assert(fixture.painted.includes(0xffccaa), '仅 tertiary 变化也重建社论轨装饰');
      renderer.setTheme({ ...palette, primaryColor: '#fff8e8', backgroundColor: '#111827' });
      renderer.frame();
      assert(glyphs().some(node => node.tint === 0xfff8e8), '社论轨正文色即时刷新');
      for (const mode of ['stage', 'geometric', 'fluid', 'solid']) {
        renderer.setBgMode(mode);
        renderer.frame();
        assert(application.stage.children[0].children[0].visible, '旧背景模式可继续使用 ' + mode);
      }
      renderer.setTuning({ lyricLayout: 'phrases' });
      renderer.setBgMode('anime');
      renderer.frame();
      const oldTimes = glyphs().map(node => [node.dataset.startTime, node.dataset.endTime]);
      renderer.setTheme(palette);
      renderer.frame();
      assert(JSON.stringify(oldTimes) === JSON.stringify(glyphs().map(node => [node.dataset.startTime, node.dataset.endTime])), '换主题保留字素时间轴');
      renderer.destroy();
      assert(!document.querySelector('.fl-sonnet-canvas'), '销毁后移除 Pixi 画布');
      return { compositions: compositions.size, imageCases: 16, minimumTransparent, atmosphereColoredPixels: atmosphere.colored };
    });
    assert.deepEqual(errors, [], '浏览器没有未捕获异常');
    console.log('PASS Chrome/Pixi 离线实测 ' + JSON.stringify(report));
  } finally {
    await browser.close();
  }
}

async function main() {
  checkResolution();
  if (process.argv.includes('--browser')) await checkBrowser();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
