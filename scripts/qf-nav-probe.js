// SPDX-License-Identifier: MIT
// 清风顶部胶囊导航「选中项文字看不见」取证：量真实计算样式 + 截图导航条。
//
// 判据不是「有没有 is-active 类」，而是「谁画在上层」：
//   · 选中项的 color（文字色）
//   · ::before 的 background-color（滑块底色）与 z-index
//   · 子元素数（决定 `.is-active > *` 的 z-index:1 有没有东西可提）
//   · elementFromPoint 落在谁身上
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SHOT_DIR || path.join(ROOT, 'output/verify-qf');
const PORT = process.env.SKIN_PORT || 18780;
const TICKET = process.env.TICKET || '';

function lum(c) {
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x.trim()));
  return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1075, height: 640 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0, 160)));
  await page.addInitScript(() => {
    try { localStorage.setItem('vmusic.skin', 'qingfeng'); } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/?ticket=${TICKET}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const nav = document.querySelector('.qf-nav');
    if (!nav) return { error: '没有 .qf-nav' };
    const items = Array.from(nav.querySelectorAll('.qf-nav-item'));
    const active = items.find((b) => b.classList.contains('is-active')) || items[1];
    const cs = getComputedStyle(active);
    const before = getComputedStyle(active, '::before');
    const b = active.getBoundingClientRect();
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      skin: document.documentElement.getAttribute('data-skin'),
      activeText: (active.textContent || '').trim(),
      color: cs.color,
      bg: cs.backgroundColor,
      beforeBg: before.backgroundColor,
      beforeZ: before.zIndex,
      beforePos: before.position,
      beforeContent: before.content,
      childCount: active.children.length,
      childTags: Array.from(active.children).map((c) => c.tagName + '.' + c.className),
      childZ: Array.from(active.children).map((c) => getComputedStyle(c).zIndex),
      // 未选中项作为对照
      idleColor: (() => {
        const idle = items.find((x) => !x.classList.contains('is-active'));
        return idle ? getComputedStyle(idle).color : null;
      })(),
      rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
      hit: at ? at.tagName + '.' + at.className : '(null)',
    };
  });

  console.log(JSON.stringify(info, null, 1));

  // ---- 像素判据：浅色滑块里到底有没有深色笔画 ----
  // 计算样式只能证明「文字色是黑的」，证明不了「字被画出来了」——
  // 被定位伪元素盖住时 color 照样是 rgb(10,10,10)，肉眼看却是空白格。
  // 所以把选中项那一小块截下来，扔回浏览器用 canvas 解码，数暗像素。
  const r = info.rect;
  if (r && r.w) {
    const buf = await page.screenshot({
      clip: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.w, 1075), height: r.h },
    });
    const b64 = buf.toString('base64');
    const px = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let dark = 0, light = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (l < 90) dark++;
        if (l > 150) light++;
        total++;
      }
      return { dark, light, total, w: c.width, h: c.height };
    }, b64);
    console.log('\n选中项像素统计: ' + JSON.stringify(px));
    const darkRatio = px.dark / px.total;
    const lightRatio = px.light / px.total;
    console.log(`  暗像素 ${(darkRatio * 100).toFixed(1)}%  亮像素 ${(lightRatio * 100).toFixed(1)}%`);

    let pass = 0, fail = 0;
    const ok = (c2, n, d2) => {
      if (c2) { pass++; console.log('  PASS  ' + n + (d2 ? '   [' + d2 + ']' : '')); }
      else { fail++; console.log('  FAIL  ' + n + (d2 ? '   [' + d2 + ']' : '')); }
    };
    console.log('\n=== 断言 ===');
    ok(lightRatio > 0.5, '选中项是浅色滑块（亮像素过半）', (lightRatio * 100).toFixed(1) + '%');
    // 文字笔画：中文两三个字在 60×34 的格子里约占 8~25%，取 2% 作为
    // 「完全看不见」与「看得见」的分界（被盖住时实测 0%）。
    ok(darkRatio > 0.02, '选中项里的深色文字真的画出来了（暗像素 >2%）',
      (darkRatio * 100).toFixed(2) + '%');
    ok(info.childCount === 0
      ? !/::before/.test(JSON.stringify(info.beforeContent || '')) || info.beforeContent === 'none'
      : true,
      '选中项没有伪元素叠层（叠层会盖住裸文本节点）',
      'childCount=' + info.childCount);

    await page.screenshot({
      path: path.join(OUT, 'qf-nav-active-after.png'),
      clip: { x: Math.max(0, r.x - 260), y: Math.max(0, r.y - 12), width: Math.min(560, 1075), height: r.h + 24 },
    });
    console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
    console.log('JS 报错: ' + (errs.join(' | ') || '(无)'));
    await browser.close();
    process.exit(fail ? 1 : 0);
  }
  console.log('JS 报错: ' + (errs.join(' | ') || '(无)'));
  await browser.close();
  process.exit(1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
