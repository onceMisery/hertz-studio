// SPDX-License-Identifier: MIT
// 清风皮肤四问题一次性取证：播放条信息 / 多余箭头 / tab 选中态 / 在线歌单。
//
// 四个都不是「看一眼觉得不对」，而是能量出来的东西：
//   · bar-title/bar-sub 的文本与几何（有没有内容、有没有盒子）
//   · 播放条右端每个可见控件的 id 与命中测试（找出那个「向下箭头」是谁）
//   · 顶部 tab 选中态的 color 与背景色是否同色（对比度算出来，不靠目测）
//   · 在线歌单接口的实际返回与页面渲染出来的行数
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = process.env.SKIN_SHOT_DIR || 'output/verify-qf';
let pass = 0, fail = 0;
const failures = [];
function ok(c, n, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); } else { fail++; failures.push(n); console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1075, height: 640 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && m.text().indexOf('401') < 0) errs.push('CONSOLE: ' + m.text().slice(0, 160)); });

  // 直接把皮肤存成清风，模拟「从别的皮肤切过来」
  await page.addInitScript(() => {
    try { localStorage.setItem('vmusic.skin', 'qingfeng'); } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${process.env.SKIN_PORT || 7634}/?token=${process.env.TK}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const skin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
  console.log('\n当前皮肤: ' + skin);
  ok(skin === 'qingfeng', '切到清风皮肤', 'data-skin=' + skin);

  // ---------- 问题 1：播放条的歌曲/歌手信息 ----------
  const bar = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return { w: Math.round(b.width), h: Math.round(b.height), display: cs.display, visibility: cs.visibility,
        opacity: cs.opacity, overflow: cs.overflow, color: cs.color, fontSize: cs.fontSize }; };
    const title = g('bar-title'), sub = g('bar-sub'), track = g('bar-track');
    return {
      hasTitleNode: !!title, hasSubNode: !!sub,
      titleText: title ? title.textContent : '(无节点)',
      subText: sub ? sub.textContent : '(无节点)',
      titleBox: box(title), subBox: box(sub), trackBox: box(track),
      snapshotTitle: (window.playerState && window.playerState.snapshot) ? window.playerState.snapshot.title : '(无 playerState)',
    };
  });
  console.log('\n[1] 播放条信息:');
  console.log('  bar-title 文本=' + JSON.stringify(bar.titleText) + ' 盒子=' + JSON.stringify(bar.titleBox));
  console.log('  bar-sub  文本=' + JSON.stringify(bar.subText) + ' 盒子=' + JSON.stringify(bar.subBox));
  ok(bar.hasTitleNode && bar.hasSubNode, '播放条有标题与副标题节点');
  ok(bar.titleText && bar.titleText.length > 0, 'bar-title 有内容', JSON.stringify(bar.titleText));
  ok(bar.subText && bar.subText.length > 0, 'bar-sub 有内容', JSON.stringify(bar.subText));
  ok(bar.titleBox && bar.titleBox.w > 0, 'bar-title 有实际宽度（没被压成 0）', bar.titleBox ? bar.titleBox.w + 'px' : '(无)');

  // ---------- 问题 2：播放条右端那个「向下箭头」 ----------
  const right = await page.evaluate(() => {
    const bar = document.querySelector('.bar');
    const br = bar.getBoundingClientRect();
    const out = [];
    bar.querySelectorAll('*').forEach((e) => {
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      // 只看右端 1/3 的控件 —— 截图里箭头在播放条最右
      if (b.left < br.left + br.width * 0.66) return;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
      out.push({
        tag: e.tagName.toLowerCase(), id: e.id || '', cls: String(e.className || '').slice(0, 40),
        title: e.title || '', x: Math.round(b.x || b.left), w: Math.round(b.width),
        use: e.querySelector ? (e.querySelector('use') ? e.querySelector('use').getAttribute('href') : '') : '',
      });
    });
    return { barRect: { x: Math.round(br.left), w: Math.round(br.width) }, items: out };
  });
  console.log('\n[2] 播放条右端可见控件:');
  right.items.forEach((i) => console.log('  ' + JSON.stringify(i)));
  const arrow = right.items.filter((i) => /chevron|arrow|down/i.test(i.id + ' ' + i.cls + ' ' + i.use));
  console.log('  → 疑似箭头控件: ' + JSON.stringify(arrow));
  await page.screenshot({ path: path.join(OUT, 'qf-bar-right.png'), clip: { x: 640, y: 500, width: 435, height: 140 } });

  // ---------- 问题 3：顶部 tab 选中态文字可见性 ----------
  const tabs = await page.evaluate(() => {
    const sels = ['.topbar .chip', '.topbar .tab', '.topbar button', '#daily-modes .chip', '.cap-tabs .chip'];
    const out = [];
    sels.forEach((s) => {
      document.querySelectorAll(s).forEach((e) => {
        const on = e.classList.contains('active') || e.getAttribute('aria-pressed') === 'true'
          || e.getAttribute('aria-selected') === 'true';
        if (!on) return;
        const cs = getComputedStyle(e);
        const b = e.getBoundingClientRect();
        out.push({ sel: s, text: (e.textContent || '').trim().slice(0, 12),
          color: cs.color, bg: cs.backgroundColor, opacity: cs.opacity,
          w: Math.round(b.width), h: Math.round(b.height) });
      });
    });
    return out;
  });
  console.log('\n[3] 选中态 tab:');
  tabs.forEach((t) => console.log('  ' + JSON.stringify(t)));

  // 对比度：把 color 解析成 rgb 再算与 bg 的差距
  function lum(c) {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    if (p.length >= 4 && p[3] === 0) return null; // 全透明 = 看父级
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  }
  tabs.forEach((t) => {
    const fg = lum(t.color), bg = lum(t.bg);
    if (fg === null || bg === null) {
      ok(false, `tab「${t.text}」选中态可读（前景/背景实测色）`, `fg=${t.color} bg=${t.bg}`);
    } else {
      const d = Math.abs(fg - bg);
      ok(d > 40, `tab「${t.text}」选中态文字与背景有足够反差`, `fg=${t.color} bg=${t.bg} 差=${Math.round(d)}`);
    }
  });
  await page.screenshot({ path: path.join(OUT, 'qf-tabs.png'), clip: { x: 400, y: 30, width: 300, height: 60 } });

  // ---------- 问题 4：在线歌单 ----------
  const op = await page.evaluate(async () => {
    const out = {};
    // 先看接口
    try {
      const r = await window.VMusicTransport.get('/v1/playlists/online');
      out.api = { ok: true, keys: r ? Object.keys(r) : null,
        总数: r && (r.total !== undefined ? r.total : (r.items || r.playlists || []).length) };
    } catch (e) { out.api = { ok: false, err: String(e.message).slice(0, 120) }; }
    // 再看页面
    const host = document.getElementById('online-playlist-grid') || document.getElementById('pl-list') || document.querySelector('.pl-grid');
    out.hostId = host ? (host.id || host.className) : '(没找到容器)';
    out.hostChildren = host ? host.children.length : 0;
    out.viewVisible = (() => { const v = document.getElementById('view-playlists'); return v ? !v.hidden : '(无此视图)'; })();
    return out;
  });
  console.log('\n[4] 在线歌单:');
  console.log('  ' + JSON.stringify(op));
  ok(op.api && op.api.ok, '在线歌单接口可用', op.api && op.api.err ? op.api.err : JSON.stringify(op.api));

  ok(errs.length === 0, '全程无 JS 报错', errs.join(' | ') || '(无)');

  console.log('\n' + '─'.repeat(52));
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });