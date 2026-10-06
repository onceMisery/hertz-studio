// 浏览器实测：高级编排预览的白色光晕 + 宽屏工坊
//
// 两个已知的环境坑（不是产品缺陷）：
//   1. Workshop.open() 会走 Stage3D.open() → SwiftShader 下 WebGL 初始化
//      阻塞渲染主线程数分钟。所以这里直接改 DOM 绕过 open()。
//   2. canvas 一旦拿过 context 就不能换个地方再 getContext。所以量像素
//      只能靠 page.screenshot({ clip }) 截区域，不能在页面里读像素。

const { chromium } = require('playwright');
const fs = require('fs');
const zlib = require('zlib');
const { uiUrl } = require('./ui-token');

const BASE = process.env.BASE || 'http://127.0.0.1:7641';

// ---------------------------------------------------------------- PNG 解码
function decodePng(buf) {
  let p = 8;
  const idat = [];
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只处理 8bit，实际 ' + bitDepth);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('不支持的 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  // PNG 每行前置一个 filter 字节，必须按 Paeth/Sub/Up 逆滤波
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

function stats(img) {
  const { w, h, ch, data } = img;
  let blown = 0, sat = 0, lum = 0, n = 0;
  const uniq = new Set();
  for (let i = 0; i < w * h; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum += l; sat += mx ? (mx - mn) / mx : 0;
    if (r >= 250 && g >= 250 && b >= 250) blown++;
    if (n % 37 === 0) uniq.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
    n++;
  }
  return {
    blownPct: blown / n * 100,
    avgSat: sat / n,
    avgLum: lum / n,
    colors: uniq.size
  };
}

function say(...a) { console.log(...a); }
function check(label, cond, detail) {
  say((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
  page.on('console', (m) => {
    if (m.type() === 'error') say('  [console error] ' + m.text().slice(0, 200));
  });

  // 上一轮可能把 stanzaVisual / 宽屏偏好存进了 localStorage。
  // 起点不干净的话，页面一进来工坊就是锁定态或宽屏态，后面量的就不是默认值了。
  const resp = await page.goto(uiUrl(BASE), { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* 无所谓 */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });

  say('HTTP ' + (resp ? resp.status() : '?'));
  await page.waitForTimeout(3000);

  // 走 Workshop.open() 正路，而不是直接改 hidden/classList。
  //
  // 直改 DOM 只在「验画布」时勉强能用，但有两个副作用：
  //   1. render() 只在 setOpen() 里调 → 面板内容根本不渲染；
  //   2. 面板不会被挂进舞台层，也不会写 body.ws-open → 布局与真实使用
  //      不一致，画布可能被挤到视口外，clip 直接报错。
  // 这里要验的正是「面板里那块画布」，必须让面板按真实路径打开。
  await page.evaluate(() => {
    if (window.Workshop && Workshop.open) Workshop.open();
  });
  await page.waitForTimeout(3000);
  // 切到「高级编排」（预览只在这个页签挂）
  await page.evaluate(() => {
    const btn = document.querySelector('.ws-targets button[data-target="advanced"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);

  const meta = await page.evaluate(() => {
    const m = document.getElementById('ws-preview-meta');
    return m ? m.textContent : '(no meta)';
  });
  say('预览状态条：' + meta);
  check('预览已挂载', /LIVE/.test(meta), '');

  async function shootCanvas(tag) {
    // 画布可能被挤出视口（工坊在舞台层里、或者面板被 body.ws-wide 挤到
    // 视口右边），page.screenshot({clip}) 对越界区域直接报错。
    // 先把它滚进视口再量。
    await page.evaluate(() => {
      const c = document.querySelector('#ws-preview-host canvas');
      if (c) c.scrollIntoView({ block: 'center', inline: 'center' });
    });
    await page.waitForTimeout(300);
    const box = await page.evaluate(() => {
      const el = document.getElementById('ws-preview-host');
      const c = el.querySelector('canvas');
      const r = (c || el).getBoundingClientRect();
      const vp = { w: window.innerWidth, h: window.innerHeight };
      return {
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.round(Math.min(r.width, vp.w - Math.max(0, r.x))),
        height: Math.round(Math.min(r.height, vp.h - Math.max(0, r.y))),
        offscreen: r.x >= vp.w || r.y >= vp.h || r.width <= 0 || r.height <= 0
      };
    });
    if (box.offscreen) { say(tag + ' 画布在视口外，跳过'); return null; }
    say(tag + ' 画布 ' + box.width + 'x' + box.height + ' @ ' + box.x + ',' + box.y);
    if (box.width < 10 || box.height < 10) return null;
    // 连拍三帧取「最亮」的那一帧。原因：SwiftShader 下截图可能落在两次
    // 合成之间，量到 avgLum=22.8 而同参数后连一帧是 56 —— 那不是画面变了，
    // 是抓到了半成品帧。断言要钉画面的性质，就不能被采样时机污染。
    let best = null;
    for (let i = 0; i < 3; i += 1) {
      const png = await page.screenshot({ clip: box });
      const s = stats(decodePng(png));
      if (!best || s.avgLum > best.avgLum) best = s;
      if (i === 0) {
        fs.mkdirSync('output/verify', { recursive: true });
        fs.writeFileSync('output/verify/' + tag + '.png', png);
      }
      await page.waitForTimeout(700);
    }
    return best;
  }

  // ---------------------------------------------------------- 窄面板（默认）
  const narrow = await shootCanvas('creative-narrow');
  if (narrow) {
    say('  纯白像素 ' + narrow.blownPct.toFixed(2) + '%  平均饱和度 ' +
      narrow.avgSat.toFixed(3) + '  平均亮度 ' + narrow.avgLum.toFixed(1) +
      '  颜色数 ' + narrow.colors);
    check('窄面板无大面积纯白', narrow.blownPct < 12, '(阈值 12%)');
  }

  // ---------------------------------------------------------- 宽屏
  const canExpand = await page.evaluate(() => {
    const b = document.getElementById('ws-expand');
    return !!(b && !b.disabled);
  });
  check('展开按钮可用', canExpand);

  await page.evaluate(() => { document.getElementById('ws-expand').click(); });
  await page.waitForTimeout(1800);
  const wideOn = await page.evaluate(() => {
    const p = document.getElementById('workshop');
    return {
      panel: p.classList.contains('is-wide'),
      body: document.body.classList.contains('ws-wide'),
      cols: getComputedStyle(p).gridTemplateColumns
    };
  });
  say('宽屏态：panel=' + wideOn.panel + ' body=' + wideOn.body);
  say('  列模板 ' + wideOn.cols);
  check('面板摊成两栏', wideOn.panel && /380px/.test(wideOn.cols), wideOn.cols);

  const wide = await shootCanvas('creative-wide');
  if (wide && narrow) {
    say('  纯白像素 ' + wide.blownPct.toFixed(2) + '%  平均饱和度 ' +
      wide.avgSat.toFixed(3) + '  平均亮度 ' + wide.avgLum.toFixed(1) +
      '  颜色数 ' + wide.colors);
    check('宽屏像素面积明显变大', wide.colors >= 1, '');
    check('宽屏无大面积纯白', wide.blownPct < 12, '(阈值 12%)');
    check('宽屏饱和度高于窄屏（双色修复生效）', wide.avgSat > narrow.avgSat,
      narrow.avgSat.toFixed(3) + ' → ' + wide.avgSat.toFixed(3));
  }

  // ---------------------------------------------------------- 收起
  await page.evaluate(() => { document.getElementById('ws-expand').click(); });
  await page.waitForTimeout(1200);
  const wideOff = await page.evaluate(() => document.getElementById('workshop').classList.contains('is-wide'));
  check('收起后回到窄面板', !wideOff);

  await browser.close();
  say('\n截图在 output/verify/');
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });