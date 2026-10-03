'use strict';
// 商籁 / 凝彩 视觉改造的浏览器实测：真跑 Pixi，确认后期 pass 能编译、能出像素。
// 用法：node scripts/check-stanza-visual-fx.js
//
// 契约脚本（check-stanza-*.js）在 Node 沙箱里只能验纯函数，验不到三件事：
//   1. 自写 GLSL 能否在真实 WebGL 上下文编译通过（语法错、varying 不匹配、
//      数组常量初始化不合法都只在浏览器里暴露）
//   2. 氛围光/角标/接缝这些新图层是否真的画出了像素
//   3. halation 的 resolution:'inherit' 是否避免了「一开后期就变糊」
// 这三件事错了页面不报错、不少元素，只是画面不对 —— 所以必须实测。
const path = require('path');
const fs = require('fs');

const web = path.join(__dirname, '../plugin/ui');
const OUT = path.join(__dirname, '../output/stanza-fx-verify');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('未找到 playwright。执行：npx -y playwright@latest install chromium');
  process.exit(2);
}

const HARNESS = `<!doctype html><meta charset="utf-8">
<style>
  /* 必须给一个**有彩色的**主题色，否则StanzaTheme.resolve() 会因低饱和
     退回 DEFAULT（accent=#f4f4f5 近白），而「画面有彩色像素」这条断言
     测的就是有没有色 —— 等于在拿无色主题验彩色。真实链路里这两个变量
     由 style.css 的主题注入，harness 里没有，得手工给。 */
  :root{--music-highlight:#d9ad61;--music-highlight-rgb:217,173,97}
  html,body{margin:0;width:100%;height:100%;background:#09090b;overflow:hidden}
  #host{position:absolute;inset:0}
  .fl-sonnet,.fl-tempera{position:absolute;inset:0}
  .fl-sonnet-canvas,.fl-tempera-canvas{position:absolute;inset:0;width:100%;height:100%}
  .fl-sonnet-eyebrow,.fl-sonnet-hud,.fl-tempera-eyebrow,.fl-tempera-note{display:none}
</style>
<div id="host"></div>`;

async function bootStage(page, mode) {
  await page.setContent(HARNESS);
  for (const file of ['vendor/pixi.min.js', 'stanza/stanza-util.js', 'stanza/stanza-theme.js',
    'stanza/stanza-sonnet-fx.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js']) {
    await page.addScriptTag({ path: path.join(web, file) });
  }
  await page.evaluate((stageMode) => {
    const fx = { position: 20000, reduced: false };
    window.__fx = fx;
    fx.lines = [
      { start_ms: 0, end_ms: 6000, text: '落日把海面染成温柔的金色' },
      { start_ms: 6000, end_ms: 13000, text: '晚风送来一句轻轻的问候' },
      { start_ms: 13000, end_ms: 20000, text: '我们沿着星光继续向前走' }
    ];
    fx.track = { id: 'fx-check', title: 'Visual FX check', path: 'fx-check' };
    window.Stage = {
      presentation: () => ({ playing: false, reduced: fx.reduced, track: fx.track }),
      position: () => fx.position,
      lyrics: () => ({ lines: fx.lines }),
      lyricTokens: line => [{ text: line.text, start_ms: line.start_ms, end_ms: line.end_ms }],
      spectrum: () => new Array(64).fill(0.35),
      kick() {}
    };
    fx.renderer = stageMode === 'sonnet'
      ? StanzaSonnet.init(document.getElementById('host'))
      : StanzaTempera.init(document.getElementById('host'));
    fx.stage = stageMode;
    // 必须显式 setTheme：真实链路里是 stage3d 拿 StanzaTheme.resolve() 的结果喂进来的，
    // harness 不喂的话渲染器会一直用 DEFAULT（accent 是近白的 #f4f4f5），
    // 于是「画面有彩色像素」这条断言在拿无色主题验彩色。
    fx.renderer.setTheme(StanzaTheme.resolve(1.35));
    // init 是惰性的：必须 setVisible(true) 才真正建 Pixi。
    // 只调 StanzaSonnet.init() 会一直停在 initialized:false。
    fx.renderer.setVisible(true);
  }, mode);
  await page.waitForFunction(() => window.__fx && window.__fx.renderer
    && window.__fx.renderer.getDebugSnapshot
    && window.__fx.renderer.getDebugSnapshot().initialized, null, { timeout: 20000 });
  // 首帧：buildShot 是惰性的，要先 render 一次才会建氛围光/角标/网屏。
  // 直接查 snapshot 会在建图之前跑，atmosphere 恒为 false。
  await page.evaluate(() => {
    window.__fx.position = 2000;
    window.__fx.renderer.frame();
  });
  await page.waitForTimeout(120);
}

async function analyze(page, label) {
  return page.evaluate((tag) => {
    const fx = window.__fx;
    fx.renderer.frame();
    // canvas 由宿主 querySelector 拿 —— Application 实例藏在闭包里，
    // 契约不保证暴露内部引用，测试也不该依赖它。
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error(tag + ': 没有画布');
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let transparent = 0, opaque = 0, colored = 0, bright = 0;
    let sumL = 0, sumL2 = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 8) { transparent += 1; continue; }
      opaque += 1;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumL += l; sumL2 += l * l;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 30) colored += 1;
      if (l > 140) bright += 1;
    }
    const total = data.length / 4;
    const snap = fx.renderer.getDebugSnapshot();
    // 亮度标准差：这一项能区分「有层次的画面」与「整屏一层灰纱」。
    // 均值一样时 std 大的才是真光效，均值一样且 std≈0 说明后期把画面糊平了。
    const mean = opaque ? sumL / opaque : 0;
    const std = opaque ? Math.sqrt(Math.max(0, sumL2 / opaque - mean * mean)) : 0;
    return {
      tag, stage: fx.stage,
      width: off.width, height: off.height,
      total, transparent, opaque, colored, bright,
      meanLuma: +mean.toFixed(1),
      lumaStd: +std.toFixed(1),
      inkRatio: +(opaque / total).toFixed(4),
      colorRatio: +(colored / total).toFixed(4),
      halation: !!snap.halation,
      atmosphere: snap.atmosphere,
      debug: snap
    };
  }, label);
}

// 抓 Pixi 内部的 shader 编译失败：它会 console.warn，但不会抛。
async function collectWarnings(page) {
  return page.evaluate(() => window.__warns || []);
}

async function runStage(browser, mode, viewport, shots) {
  const page = await browser.newPage({ viewport });
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    const t = m.text();
    if (/shader|glsl|compile|link error|WARNING/i.test(t)) warns.push(t.slice(0, 300));
  });
  await bootStage(page, mode);
  const report = [];
  for (const t of shots) {
    const r = await page.evaluate((ms) => { window.__fx.position = ms; return ms; }, t);
    await page.waitForTimeout(160);
    const a = await analyze(page, mode + '@' + t);
    report.push(a);
    await page.screenshot({ path: path.join(OUT, `${mode}-${viewport.width}x${viewport.height}-t${t}.png`) });
    a.at = r;
  }
  // 图片背景模式：氛围光必须收掉，否则角落不再全透明（契约要求 ≥90% 透明）
  const anime = await page.evaluate(() => {
    const fx = window.__fx;
    fx.renderer.setBgMode ? fx.renderer.setBgMode('anime') : null;
    return true;
  });
  await page.waitForTimeout(200);
  const animeReport = await analyze(page, mode + '@anime');
  await page.close();
  return { report, animeReport, errors, warns, anime };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const failures = [];
  const ok = (cond, msg) => { if (!cond) { failures.push(msg); console.error('FAIL:', msg); } else console.log('ok -', msg); };

  for (const mode of ['sonnet', 'tempera']) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { report, animeReport, errors, warns } = await runStage(browser, mode, viewport, [6500, 13500]);
      const tag = mode + ' ' + viewport.width + 'x' + viewport.height;
      console.log('\n== ' + tag + ' ==');
      report.forEach(r => console.log('  t=' + r.at,
        'ink=' + r.inkRatio, 'color=' + r.colorRatio,
        'meanL=' + r.meanLuma, 'std=' + r.lumaStd,
        'halation=' + r.halation, 'atmos=' + r.atmosphere));
      console.log('  [图片背景模式] transparent=' +
        (animeReport.transparent / animeReport.total).toFixed(3) + ' halation=' + animeReport.halation);

      ok(errors.length === 0, tag + ' 无未捕获异常 ' + JSON.stringify(errors.slice(0, 2)));
      ok(warns.length === 0, tag + ' 无 shader 编译告警 ' + JSON.stringify(warns.slice(0, 2)));
      report.forEach(r => {
        ok(r.inkRatio > 0.02, tag + ' t=' + r.at + ' 画面有实际内容 (ink=' + r.inkRatio + ')');
        // std 太低 = 后期把画面糊成一层灰纱。这正是 resolution 钉在 1 时的症状。
        ok(r.lumaStd > 8, tag + ' t=' + r.at + ' 画面有明暗层次 std=' + r.lumaStd);
        ok(r.meanLuma > 4, tag + ' t=' + r.at + ' 画面不是全黑 meanL=' + r.meanLuma);
      });
      if (mode === 'sonnet') {
        report.forEach(r => ok(r.atmosphere === true, tag + ' t=' + r.at + ' 氛围光层已建'));
      }
      ok(report.some(r => r.colorRatio > 0.01), tag + ' 画面有彩色像素（配色未被洗成灰）');
      ok(report.some(r => r.halation === true), tag + ' halation 后期生效');
      // 透明度的期望按舞台性质分：商籁是线稿叠加在宿主背景上，必须大部分透明；
      // 凝彩是整屏不透明色块 MV（设计如此），不适用透明断言。
      if (mode === 'sonnet') {
        ok(animeReport.transparent / animeReport.total > 0.9,
          tag + ' 图片模式 ≥90% 像素透明 (got ' + (animeReport.transparent / animeReport.total).toFixed(3) + ')');
      } else {
        // 凝彩图片模式：色块**不会**撤掉，反而更实（blockAlpha 0.62 → 0.94）——
        // 它是海报式 MV，壁纸只是环境，色块本身才是主体。
        // 所以断言反过来：切到图片模式后亮度应上升，且歌词照旧绘制。
        // 这条验的是 bgMode 真的传进了 engineTuning（shotKey 含 bgMode，会重建镜头）。
        ok(animeReport.meanLuma > report[0].meanLuma,
          tag + ' 图片模式色块更实 (meanL ' + report[0].meanLuma + ' → ' + animeReport.meanLuma + ')');
        ok(animeReport.inkRatio > 0.001, tag + ' 图片模式仍绘制歌词');
      }
    }
  }
  await browser.close();
  if (failures.length) { console.error('\n' + failures.length + ' 项失败'); process.exit(1); }
  console.log('\nstanza 视觉后期实测全部通过，截图在 ' + OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
