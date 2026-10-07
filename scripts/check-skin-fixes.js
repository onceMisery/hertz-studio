// SPDX-License-Identifier: MIT
// 六个皮肤问题的浏览器实测验收。每一项都量**真实几何/计算样式**，
// 不看 CSS 声明 —— 这批问题的失败模式全是「不报错、不少元素，只是界面不对」。
//
// 跑法：NODE_PATH=<playwright> SKIN_PORT=18790 SKIN_TOKEN=... node scripts/check-skin-fixes.js
const { chromium } = require('playwright');

const PORT = process.env.SKIN_PORT || '18790';
const BASE = `http://127.0.0.1:${PORT}/`;
const TOKEN = process.env.SKIN_TOKEN || '';
const OUT = process.env.SKIN_SHOT_DIR || 'output/verify-skins';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { fail += 1; failures.push(name + (detail ? '  [' + detail + ']' : '')); console.log('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function section(t) { console.log('\n' + t); }

// 强制舞台可见：body[data-stage-idle="1"] .stage{display:none} 会让整列消失，
// 量不到任何东西。判据是「没有在放的东西」，与本次要验的布局无关。
const FORCE_STAGE = 'body[data-stage-idle="1"] .stage{display:flex !important;}';

async function applySkin(page, id) {
  await page.evaluate((s) => window.Skins.apply(s), id);
  await page.waitForTimeout(650);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(BASE + (TOKEN ? `?token=${TOKEN}` : ''), { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(1500);
  await page.evaluate((css) => {
    const s = document.createElement('style');
    s.id = '__force-stage';
    s.textContent = css;
    document.head.appendChild(s);
  }, FORCE_STAGE);

  // ---------------------------------------------------------------- 问题 3/4/5
  section('问题 3/4/5：在设置页里切皮肤，首页必须有内容（不空白、不停在设置页）');
  for (const target of ['liunian', 'qingfeng', 'ios', 'sheen', 'workbench', 'classic']) {
    // 每轮都先回到 classic 并进入设置页 —— 这才是用户的真实路径
    await applySkin(page, 'classic');
    await page.evaluate(() => {
      const item = document.querySelector('.rail-item[data-view="settings"]');
      if (item) item.click();
    });
    await page.waitForTimeout(400);
    await applySkin(page, target);
    const m = await page.evaluate(() => {
      const col = document.getElementById('column');
      const vis = [...col.querySelectorAll('.view')].filter((v) => {
        const cs = getComputedStyle(v);
        return !v.hidden && cs.display !== 'none' && v.getBoundingClientRect().height > 8;
      });
      const lib = document.getElementById('view-library');
      return {
        visible: vis.map((v) => v.id),
        settingsVisible: vis.some((v) => v.id === 'view-settings'),
        libH: lib ? Math.round(lib.getBoundingClientRect().height) : 0,
        libHasContent: lib ? lib.querySelectorAll('.track, .daily-strip, .pl-card, .empty-card, .hint').length : 0,
        colH: Math.round(col.getBoundingClientRect().height),
      };
    });
    ok(m.visible.length > 0, `切到 ${target}：中栏有可见视图`, JSON.stringify(m.visible));
    ok(m.libH > 100, `切到 ${target}：首页有实际高度`, 'libH=' + m.libH);
    ok(!m.settingsVisible, `切到 ${target}：不停在设置页`, 'visible=' + JSON.stringify(m.visible));
    ok(m.libHasContent > 0, `切到 ${target}：首页有内容节点`, 'nodes=' + m.libHasContent);
    await page.screenshot({ path: `${OUT}/fix-switch-${target}.png` });
  }

  // ---------------------------------------------------------------- 问题 1
  section('问题 1：播放条不能永久消失（显隐竞态）');
  await applySkin(page, 'sheen');
  const race = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = document.getElementById('bar-pin-toggle');
    const restore = document.getElementById('bar-restore');
    const bar = document.querySelector('.bar');
    const out = [];
    // 快速收起后点击独立恢复入口，旧动画的延迟回调不能再把播放栏藏掉。
    for (let i = 0; i < 3; i += 1) {
      btn.click();
      await sleep(60);
      restore.click();
      await sleep(700);           // 越过旧动画回调曾使用的时间窗口
      out.push({
        round: i + 1,
        isHidden: bar.classList.contains('is-hidden'),
        display: getComputedStyle(bar).display,
        bodyBarHidden: document.body.classList.contains('bar-hidden'),
      });
    }
    // 最后确保是「显示」态，且真的可见
    if (bar.classList.contains('is-hidden')) { restore.click(); await sleep(700); }
    const r = bar.getBoundingClientRect();
    return {
      rounds: out,
      finalIsHidden: bar.classList.contains('is-hidden'),
      finalDisplay: getComputedStyle(bar).display,
      finalRect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
      inViewport: r.top < window.innerHeight && r.bottom > 0,
    };
  });
  console.log('    ' + JSON.stringify(race.rounds));
  ok(race.rounds.every((x) => !x.isHidden), '连点两下折叠按钮后播放条仍在',
    JSON.stringify(race.rounds.map((x) => x.isHidden)));
  ok(!race.finalIsHidden && race.finalDisplay !== 'none', '最终态播放条未隐藏',
    'display=' + race.finalDisplay);
  ok(race.finalRect.h > 20 && race.inViewport, '播放条在视口内且有高度', JSON.stringify(race.finalRect));
  await page.screenshot({ path: `${OUT}/fix-bar-race.png` });

  // ---------------------------------------------------------------- 问题 1/2
  section('问题 1/2：舞台面板没有多余的横向滚动条，几何对齐');
  for (const target of ['sheen', 'workbench']) {
    await applySkin(page, target);
    await page.evaluate(() => { const b = document.querySelector('.bar'); b.classList.remove('is-hidden'); b.style.transform = ''; b.style.opacity = ''; });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const st = document.getElementById('stage');
      const r = st.getBoundingClientRect();
      const cs = getComputedStyle(st);
      const bar = document.querySelector('.bar');
      const br = bar.getBoundingClientRect();
      // **判据是「有没有可见滚动条」，不是 scrollWidth。**
      // overflow:hidden 时 scrollWidth 仍然报告被裁掉的尺寸（inset:-30% 的
      // 光晕让 sheen 报 543 / clientW 418），scrollLeft 也能被程序化赋值 ——
      // 但滚动条**不画、用户也滚不到**。拿 scrollWidth 判会得出「没修好」
      // 的假结论（我第一版就写在这里，红了两轮）。
      //
      // 用户能看到滚动条的条件：overflow 算出来是 auto / scroll，
      // 且溢出量 > 0。gutter（offsetWidth - clientWidth）在有滚动条时
      // 会明显大于边框宽度，这里一并量出来佐证。
      const borderX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const xOver = st.scrollWidth - st.clientWidth;
      const yOver = st.scrollHeight - st.clientHeight;
      return {
        rect: { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) },
        overflowX: cs.overflowX, overflowY: cs.overflowY,
        xOver, yOver,
        // 会画出滚动条吗
        showsXBar: (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && xOver > 0,
        showsYBar: (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && yOver > 0,
        gutterX: st.offsetWidth - st.clientWidth - borderX,
        gutterY: st.offsetHeight - st.clientHeight - borderY,
        modesFit: (() => {
          const modes = document.getElementById('stage-modes');
          if (!modes) return null;
          const mr = modes.getBoundingClientRect();
          return { right: Math.round(mr.right), over: Math.round(mr.right - r.right), w: Math.round(mr.width) };
        })(),
        gapToBar: Math.round(br.top - r.bottom),
        barTop: Math.round(br.top),
        viewportH: window.innerHeight,
      };
    });
    console.log('    ' + target + ': ' + JSON.stringify(m));
    ok(!m.showsXBar && !m.showsYBar,
      `${target}：面板不画滚动条`,
      `overflow=${m.overflowX}/${m.overflowY} 溢出=${m.xOver}/${m.yOver} 槽=${m.gutterX}/${m.gutterY}`);
    ok(m.gutterX <= 1 && m.gutterY <= 1,
      `${target}：没有滚动条槽占宽`, `gutterX=${m.gutterX} gutterY=${m.gutterY}`);
    ok(m.modesFit && m.modesFit.over <= 1, `${target}：模式胶囊不顶破面板`, JSON.stringify(m.modesFit));
    ok(m.gapToBar >= 0, `${target}：面板不压进播放条`, 'gap=' + m.gapToBar);
    ok(m.rect.w > 100 && m.rect.h > 200, `${target}：面板尺寸正常`, JSON.stringify(m.rect));
    await page.screenshot({ path: `${OUT}/fix-stage-${target}.png` });
  }

  // ---------------------------------------------------------------- 问题 6
  section('问题 6：清风墙上/下一曲 + 左下角卡片悬停播放按钮');
  await applySkin(page, 'qingfeng');
  await page.evaluate(() => {
    const fake = [];
    for (let i = 0; i < 64; i += 1) {
      fake.push({
        id: `probe-${i}`, index: i, badge: String(i + 1).padStart(2, '0'),
        title: `曲目 ${i + 1} · 拼接测试`,
        artist: ['棱镜', '窦唯', 'Radiohead', '坂本龙一'][i % 4],
        duration: 180000 + i * 7300, cover: '',
        current: i === 3, playing: i === 3, progress: 0.42,
        sourceKey: 'queue', queueItem: true,
      });
    }
    window.__qfProbeQueue = fake;
    window.__qfLog = [];
    document.addEventListener('qf:panel', (e) => {
      const d = e.detail || {};
      window.__qfLog.push({ action: d.action, delta: d.delta, itemId: d.item ? d.item.id : null });
    });
    document.addEventListener('qf:panel', (e) => {
      const d = e.detail;
      if (!d || d.action !== 'source-request' || !d.source || d.source.key !== 'queue') return;
      d.source = { key: 'queue', label: d.source.label, kind: 'queue', items: window.__qfProbeQueue, emptyHint: d.source.emptyHint };
    });
    const q = document.querySelector('.rail-item[data-view="queue"]');
    if (q) q.click();
  });
  await page.waitForTimeout(500);
  await page.click('.qf-nav-icon');
  await page.waitForTimeout(1700);

  const wallN = await page.evaluate(() => document.querySelectorAll('.qf-poster').length);
  ok(wallN > 0, '墙渲染出海报', 'posters=' + wallN);

  const btns = await page.evaluate(() => {
    const root = document.querySelector('.qf-poster.is-expanded') || document.querySelector('.qf-poster');
    if (!root) return null;
    return [...root.querySelectorAll('.qf-chrome button')].map((b) => {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const at = document.elementFromPoint(cx, cy);
      return { title: b.title, x: Math.round(cx), y: Math.round(cy), hits: !!(at && (at === b || b.contains(at))) };
    });
  });
  ok(btns && btns.length >= 3, '展开卡有三个控制按钮', 'n=' + (btns ? btns.length : 0));
  if (btns && btns.length >= 3) {
    ok(btns[0].hits && btns[2].hits, '上/下一曲按钮可命中', JSON.stringify(btns.map((b) => b.hits)));
    await page.evaluate(() => { window.__qfLog.length = 0; });
    await page.mouse.click(btns[1].x, btns[1].y); await page.waitForTimeout(350);
    await page.mouse.click(btns[2].x, btns[2].y); await page.waitForTimeout(350);
    await page.mouse.click(btns[0].x, btns[0].y); await page.waitForTimeout(450);
    const evts = await page.evaluate(() => window.__qfLog.slice());
    console.log('    qf:panel: ' + JSON.stringify(evts));
    const steps = evts.filter((e) => e.action === 'step-track').map((e) => e.delta);
    ok(steps.includes(1), '下一首发 step-track +1', JSON.stringify(steps));
    ok(steps.includes(-1), '上一首发 step-track -1', JSON.stringify(steps));
    ok(!evts.some((e) => e.action === 'activate' && e.delta),
      '不再发 activate+delta（那是「永远停在第一首」的写法）');
  }

  // 左下角卡片的悬停播放按钮
  const peekIdle = await page.evaluate(() => {
    const p = document.querySelector('.qf-queue-peek');
    if (!p) return { err: 'no .qf-queue-peek' };
    const btn = p.querySelector('.qf-queue-peek-play');
    if (!btn) return { err: 'no play button' };
    const cs = getComputedStyle(btn);
    const pr = p.getBoundingClientRect();
    return { present: true, opacity: cs.opacity, pointerEvents: cs.pointerEvents,
      btnRect: (() => { const b = btn.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; })(),
      peekRect: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) } };
  });
  console.log('    悬停前: ' + JSON.stringify(peekIdle));
  ok(peekIdle.present, '左下角卡片有播放按钮节点', JSON.stringify(peekIdle));
  if (peekIdle.present) {
    ok(Number(peekIdle.opacity) < 0.2 && peekIdle.pointerEvents === 'none',
      '未悬停时按钮不可见也不吃命中', 'opacity=' + peekIdle.opacity + ' pe=' + peekIdle.pointerEvents);
    // 悬停
    await page.mouse.move(peekIdle.peekRect.x + 30, peekIdle.peekRect.y + 20);
    await page.waitForTimeout(500);
    const peekHover = await page.evaluate(() => {
      const btn = document.querySelector('.qf-queue-peek .qf-queue-peek-play');
      const cs = getComputedStyle(btn);
      const b = btn.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const at = document.elementFromPoint(cx, cy);
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents,
        hits: !!(at && (at === btn || btn.contains(at))),
        label: btn.getAttribute('aria-label'), w: Math.round(b.width), h: Math.round(b.height) };
    });
    console.log('    悬停后: ' + JSON.stringify(peekHover));
    ok(Number(peekHover.opacity) > 0.9, '悬停后按钮浮现', 'opacity=' + peekHover.opacity);
    ok(peekHover.pointerEvents !== 'none', '悬停后按钮吃命中', 'pe=' + peekHover.pointerEvents);
    ok(peekHover.hits, '悬停后按钮中心点命中自己', JSON.stringify(peekHover));
    ok(peekHover.label === '暂停' || peekHover.label === '播放',
      '按钮有无障碍标签', 'label=' + peekHover.label);
    await page.screenshot({ path: `${OUT}/fix-qf-peek-hover.png` });

    // 点它：应发出 toggle-play（已在放这一首）
    await page.evaluate(() => { window.__qfLog.length = 0; });
    const b2 = await page.evaluate(() => {
      const btn = document.querySelector('.qf-queue-peek .qf-queue-peek-play');
      const b = btn.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    });
    await page.mouse.click(b2.x, b2.y);
    await page.waitForTimeout(500);
    const evts2 = await page.evaluate(() => window.__qfLog.slice());
    console.log('    点浮条按钮后: ' + JSON.stringify(evts2));
    ok(evts2.some((e) => e.action === 'toggle-play' || e.action === 'activate'),
      '浮条按钮发出播放意图', JSON.stringify(evts2.map((e) => e.action)));
  }
  await page.screenshot({ path: `${OUT}/fix-qf-wall.png` });

  // ---------------------------------------------------------------- 运行期无报错
  section('运行期');
  ok(errors.length === 0, '全程无 JS 报错', errors.join(' | ') || '(无)');

  console.log('\n' + '─'.repeat(60));
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  require('fs').mkdirSync(OUT, { recursive: true });
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
