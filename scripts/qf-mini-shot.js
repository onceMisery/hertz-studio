// SPDX-License-Identifier: MIT
// 清风皮肤「迷你播放器」取证脚本：默认皮肤播放 → 切清风 → 量浮动播放卡的真实几何并截图。
//
// 用法（服务已在 SKIN_PORT 上跑着、且带 token）：
//   SKIN_PORT=18780 node scripts/qf-mini-shot.js
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SHOT_DIR || path.join(ROOT, 'output/verify-qf');
const PORT = process.env.SKIN_PORT || 18780;
const W = Number(process.env.SHOT_W || 1440);
const H = Number(process.env.SHOT_H || 900);
const TAG = process.env.SHOT_TAG || 'qfmini';

const BASE = `http://127.0.0.1:${PORT}`;

function api(method, url, body) {
  return fetch(BASE + url, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      global.__TOKEN ? { 'x-vmusic-token': global.__TOKEN } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return txt; }
  });
}

async function waitFor(pred, label, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout waiting for ' + label);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ---- 1. 开浏览器拿 token ----
  // 首页要带**一次性** ticket（`/?ticket=…`）才 200；ticket 被 fetch 吃掉一次后
  // 浏览器再去就是 401 白屏（实测 skin/bar 全是 null）——所以必须由页面自己取。
  const ticket = process.env.TICKET || '';
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0, 160)));
  await page.goto(`${BASE}/?ticket=${ticket}`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => {
    const t = await page.evaluate(() => (typeof window.__VMUSIC_TOKEN__ === 'string' ? window.__VMUSIC_TOKEN__ : ''));
    if (!t) return null;
    global.__TOKEN = t;
    return t;
  }, 'session token');
  console.log('token ok');

  // ---- 2. 造曲 + 扫描 ----
  const folder = path.join(ROOT, 'output/skin-playback/fixtures');
  fs.mkdirSync(folder, { recursive: true });
  const n = 6;
  for (let i = 0; i < n; i++) {
    const p = path.join(folder, `Audit ${String(i + 1).padStart(2, '0')}.wav`);
    if (fs.existsSync(p)) continue;
    const samples = 8000 * 8;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    fs.writeFileSync(p, wav);
  }
  const scanResp = await api('POST', '/v1/library/scan', { root: folder });
  console.log('scan -> ' + JSON.stringify(scanResp).slice(0, 300));
  let last = null;
  const tracks = await waitFor(async () => {
    const r = await api('GET', '/v1/tracks?limit=50');
    last = r;
    const list = (r && (r.tracks || r.items)) || [];
    return list.length ? list : null;
  }, 'scan produce tracks', 30000).catch((e) => {
    console.log('tracks -> ' + JSON.stringify(last).slice(0, 400));
    throw e;
  });
  console.log(`曲目 ${tracks.length} 首`);

  // ---- 3. 播放第一首（服务端播，页面负责同步）----
  const queue = tracks.slice(0, 5).map((t) => t.id);
  await api('POST', '/v1/player/load', { track_id: queue[0], queue });
  await api('POST', '/v1/player/play');
  await new Promise((r) => setTimeout(r, 600));

  // ---- 4. 等首屏渲染完（默认皮肤）----
  await page.waitForTimeout(6000);

  const shot = async (name) => {
    const p = path.join(OUT, `${TAG}-${name}.png`);
    await page.screenshot({ path: p });
    return p;
  };

  const measure = () => page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(b.width), h: Math.round(b.height),
        x: Math.round(b.left), y: Math.round(b.top),
        display: cs.display, position: cs.position,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
      };
    };
    const stage = document.getElementById('stage');
    const kids = [];
    if (stage) {
      stage.querySelectorAll(':scope > *').forEach((el) => {
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        kids.push({
          cls: (el.className || el.tagName).toString().slice(0, 34),
          w: Math.round(b.width), h: Math.round(b.height),
          display: cs.display,
        });
      });
    }
    return {
      skin: document.documentElement.getAttribute('data-skin'),
      stageIdle: document.body.dataset.stageIdle || '',
      vw: window.innerWidth, vh: window.innerHeight,
      stage: box('#stage'),
      bar: box('.bar'),
      capsule: box('#capsule'),
      npModal: box('#np-modal'),
      stageKids: kids,
    };
  });

  console.log('\n=== 默认皮肤 ===');
  console.log(JSON.stringify(await measure(), null, 1));
  await shot('01-default');

  // ---- 5. 切清风（改持久化键 + 重载，模拟真实切换）----
  await page.evaluate(() => { try { localStorage.setItem('vmusic.skin', 'qingfeng'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  console.log('\n=== 清风皮肤 ===');
  const qf = await measure();
  console.log(JSON.stringify(qf, null, 1));
  await shot('02-qingfeng');

  // 再把舞台卡单独截一张（夹进视口内，避免 clip 越界报错）
  if (qf.stage && qf.stage.visible) {
    const clip = {
      x: Math.max(0, qf.stage.x), y: Math.max(0, qf.stage.y),
      width: Math.min(qf.stage.w, W - Math.max(0, qf.stage.x)),
      height: Math.min(qf.stage.h, H - Math.max(0, qf.stage.y)),
    };
    await page.screenshot({ path: path.join(OUT, `${TAG}-03-stage-crop.png`), clip });
    console.log('\n舞台卡 crop: ' + JSON.stringify(clip));
  }

  // ---- 6. 行为验收：紧凑尺寸 / 拖动 / 关闭 / 播放按钮转发 ----
  let pass = 0, fail = 0;
  const ok = (c, n, d) => {
    if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
    else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
  };
  console.log('\n=== 行为验收 ===');
  // ≤1100px 是清风的有意设计：窄屏侧卡整个撤掉（底部胶囊已有全部控件）。
  const miniExpected = W > 1100;
  if (!miniExpected) {
    ok(qf.stage && !qf.stage.visible, '窄屏（≤1100px）迷你卡按设计整卡撤掉',
      qf.stage ? 'display=' + qf.stage.display : '');
  } else if (qf.stage && qf.stage.visible) {
    ok(qf.stage.w <= 260, '迷你卡宽度紧凑（≤260px）', qf.stage.w + 'px');
    ok(qf.stage.h <= 240, '迷你卡高度紧凑（≤240px，改前 636px）', qf.stage.h + 'px');
    // 播放态图标：两颗图标都该在 DOM 里，显示哪颗由 body.is-playing 决定
    const icons = await page.evaluate(() => {
      const b = document.querySelector('.qf-mini-play');
      if (!b) return null;
      const vis = (s) => {
        const el = b.querySelector(s);
        if (!el) return false;
        return getComputedStyle(el).display !== 'none';
      };
      return { exists: true, play: vis('.ic-play'), pause: vis('.ic-pause'),
        bodyPlaying: document.body.classList.contains('is-playing') };
    });
    ok(icons && icons.exists, '迷你卡有播放/暂停按钮');
    ok(icons && (icons.play !== icons.pause), '播放/暂停图标互斥且跟播放态走',
      icons ? `playing=${icons.bodyPlaying} play=${icons.play} pause=${icons.pause}` : '');
  } else {
    ok(false, '清风下迷你卡可见', JSON.stringify(qf.stage));
  }

  // 拖动：pointer 按下卡片 → 移动 → 松手，位置应变化且落进 localStorage
  if (miniExpected) {
  const before = await page.evaluate(() => {
    const b = document.getElementById('stage').getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top) };
  });
  const by = await page.evaluate(() => {
    const h = document.querySelector('#stage .stage-head');
    const b = h.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(12, b.height / 2)) };
  });
  await page.mouse.move(by.x, by.y);
  await page.mouse.down();
  await page.mouse.move(by.x - 220, by.y + 130, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const b = document.getElementById('stage').getBoundingClientRect();
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem('vmusic.qf.stage.pos.v1')); } catch (e) {}
    return { x: Math.round(b.left), y: Math.round(b.top), pos };
  });
  const moved = Math.abs(after.x - before.x) > 60 && Math.abs(after.y - before.y) > 60;
  ok(moved, '拖动后卡片真的挪了', `${before.x},${before.y} → ${after.x},${after.y}`);
  ok(after.pos && Math.abs(after.pos.x - after.x) <= 2, '拖动后位置写进 localStorage',
    JSON.stringify(after.pos));
  // 拖完截一张，确认卡片落在内容上方而不是把内容挤走
  await shot('04-after-drag');

  // 播放按钮转发：点迷你卡的播放键应与点底部 #playpause 等效
  const toggled = await page.evaluate(async () => {
    const st = () => fetch('/v1/state', { headers: { 'x-vmusic-token': window.__VMUSIC_TOKEN__ } })
      .then((r) => r.json());
    const a = await st();
    document.querySelector('.qf-mini-play').click();
    await new Promise((r) => setTimeout(r, 800));
    const b = await st();
    return { before: a.playing, after: b.playing };
  });
  ok(toggled.before !== toggled.after, '迷你卡播放键转发了播放意图（走 app.js 原路径）',
    `${toggled.before} → ${toggled.after}`);

  // 关闭：卡片消失 + 状态落盘
  await page.evaluate(() => document.querySelector('.qf-mini-close').click());
  await page.waitForTimeout(200);
  const closedState = await page.evaluate(() => ({
    hidden: document.getElementById('stage').classList.contains('qf-mini-closed'),
    stored: localStorage.getItem('vmusic.qf.stage.closed.v1'),
    disp: getComputedStyle(document.getElementById('stage')).display,
  }));
  ok(closedState.hidden && closedState.stored === '1' && closedState.disp === 'none',
    '关闭后卡片收起并记住', JSON.stringify(closedState));
  await shot('05-closed');

  // 换曲自动回来
  await page.evaluate(async () => {
    await fetch('/v1/player/next', {
      method: 'POST', headers: { 'x-vmusic-token': window.__VMUSIC_TOKEN__ },
    });
  });
  await page.waitForTimeout(1200);
  const reopened = await page.evaluate(() => ({
    hidden: document.getElementById('stage').classList.contains('qf-mini-closed'),
    disp: getComputedStyle(document.getElementById('stage')).display,
  }));
  ok(!reopened.hidden && reopened.disp !== 'none', '换曲后迷你卡自动回来', JSON.stringify(reopened));
  } // end miniExpected

  // ---- 7. 切回 classic：.stage 必须回到栅格里的原样（无内联脏样式）----
  await page.evaluate(() => { try { localStorage.setItem('vmusic.skin', 'classic'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const back = await page.evaluate(() => {
    const el = document.getElementById('stage');
    const cs = getComputedStyle(el);
    return {
      display: cs.display, position: cs.position,
      inlineLeft: el.style.left, inlineTop: el.style.top,
      inlineRight: el.style.right, inlineBottom: el.style.bottom,
      hasMiniCtrl: !!el.querySelector('.qf-mini-ctrl'),
      hasMiniClose: !!el.querySelector('.qf-mini-close'),
      miniClass: el.className,
    };
  });
  console.log('\n=== 切回 classic ===');
  console.log(JSON.stringify(back, null, 1));
  // classic 自身在窄屏会把 .stage 变成 fixed 浮层（既有行为），只验宽屏。
  if (W > 1100) {
    ok(back.display === 'flex' && back.position !== 'fixed', 'classic 下舞台回到栅格布局',
      back.display + ' / ' + back.position);
  } else {
    ok(back.display !== 'none', 'classic 窄屏舞台保持既有形态', back.display + ' / ' + back.position);
  }
  ok(!back.inlineLeft && !back.inlineTop && !back.inlineRight && !back.inlineBottom,
    '清风留下的内联定位已清干净', JSON.stringify([back.inlineLeft, back.inlineTop]));
  ok(!back.hasMiniCtrl && !back.hasMiniClose && !/qf-mini/.test(back.miniClass),
    '皮肤注入的节点与类已摘干净', back.miniClass);
  await shot('06-back-to-classic');

  console.log(`\n行为验收：${pass} PASS / ${fail} FAIL`);
  console.log('JS 报错: ' + (errs.join(' | ') || '(无)'));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
