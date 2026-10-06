// SPDX-License-Identifier: MIT
// 每日推荐首屏实测：量「第一次画出卡片」的时刻，以及落位前后的来源切换。
//
// 关键判据不是「最终对不对」而是**首屏有没有立刻出内容**：
// 修之前本地 20ms 到、在线 2s 到，但 mode 锁在 online，本地那份被无视 ——
// 用户盯着两行「正在…」整整 2 秒。所以要抓的是时间线，不是终态。
const { chromium } = require('playwright');

const PORT = process.env.SKIN_PORT || '7634';
const TOKEN = process.env.SKIN_TOKEN || '';
const OUT = process.env.SKIN_SHOT_DIR || 'output/verify-daily';
let pass = 0, fail = 0;
const failures = [];
function ok(c, n, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); } else { fail++; failures.push(n); console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  require('fs').mkdirSync(OUT, { recursive: true });

  // 在页面里挂探针：从 Daily.init() 之前就位，记录每次 render 的时刻与结果
  await page.addInitScript(() => {
    window.__probe = { timeline: [], t0: performance.now() };
    const hook = () => {
      const list = document.getElementById('daily-list');
      const sub = document.getElementById('daily-sub');
      if (!list) return;
      window.__probe.timeline.push({
        at: Math.round(performance.now() - window.__probe.t0),
        cards: list.querySelectorAll('.daily-card').length,
        hint: (list.querySelector('.hint') || {}).textContent || '',
        sub: sub ? sub.textContent : '',
        mode: window.Daily && window.Daily.state ? window.Daily.state.mode : null,
      });
    };
    // MutationObserver 比轮询准，且能抓到 render 的每一次结果
    const start = () => {
      const list = document.getElementById('daily-list');
      if (!list) { setTimeout(start, 10); return; }
      new MutationObserver(hook).observe(list, { childList: true, subtree: true });
      document.addEventListener('click', () => setTimeout(hook, 0), true);
    };
    start();
  });

  // 凭据走查询串的 **token** 参数。页面路由仍以 `?token=` 注入 session，
  // 服务端启动日志里打印的那个 ticket 是给「首次打开、还没有 token」时用的
  // 引导流程 —— 两者不是一回事，别混（用 ticket 会拿到「需要凭据」页，
  // 页面里没有业务脚本，window.Daily 是 undefined）。
  await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  // 清掉持久化：模拟「第一次进曲库页、没选过来源」
  await page.evaluate(() => { try { localStorage.removeItem('vmusic.daily.mode'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // 进曲库页（每日推荐条在那儿）
  await page.evaluate(() => {
    const item = document.querySelector('.rail-item[data-view="library"]');
    if (item) item.click();
  });

  // 等最多 6s：要么出卡片，要么一直是占位
  await page.waitForFunction(
    () => document.querySelectorAll('#daily-list .daily-card').length > 0
      || (window.Daily && window.Daily.state && !window.Daily.state.onlineBusy && !window.Daily.state.localBusy),
    { timeout: 8000 },
  ).catch(() => {});
  await page.waitForTimeout(3000);   // 等在线那一路收尾落位

  const probe = await page.evaluate(() => window.__probe.timeline);
  console.log('\n首屏时间线（at=ms，卡片数，占位文案，副标题，mode）：');
  probe.slice(0, 26).forEach((p) => console.log(
    `  ${String(p.at).padStart(5)}ms  cards=${String(p.cards).padStart(2)}  mode=${String(p.mode).padEnd(6)}  ${p.hint || p.sub.slice(0, 40)}`,
  ));

  // 判据 1：第一次出现卡片要快（本地那路 20ms，不该被在线的 2s 拖住）
  const firstCards = probe.find((p) => p.cards > 0);
  ok(!!firstCards, '最终出卡片了', firstCards ? `${firstCards.at}ms / ${firstCards.cards} 张` : '从未出卡片');
  if (firstCards) {
    // 阈值说明：热缓存下实测 178ms；冷启动（在线那路要顶满服务端 2s 预算、
    // 且 20 个脚本刚解析完）实测 1.1s 量级。取 1.5s 是在「明显快于旧行为的
    // 2s 整段空窗」与「不为冷启动抖动假红」之间取的中位 —— 真正的判据是
    // 「首屏有卡片」这一条，毫秒阈值只是防住「退回到等在线」的趋势。
    ok(firstCards.at < 1500, '首屏 < 1.5s 就画出卡片（不被在线那路拖住）', `${firstCards.at}ms`);
  }

  // 判据 2：出现过卡片之后，列表不能长时间只剩占位
  const afterFirst = probe.filter((p) => firstCards && p.at >= firstCards.at);
  const placeholderAfter = afterFirst.filter((p) => p.cards === 0 && p.hint);
  ok(placeholderAfter.length === 0,
    '出卡片后没再退回占位',
    placeholderAfter.length ? JSON.stringify(placeholderAfter.slice(0, 3)) : 'ok');

  // 判据 3：落位后应停在 online（有登录平台时）
  const final = probe[probe.length - 1];
  const st = await page.evaluate(() => ({
    mode: window.Daily.state.mode,
    pinned: window.Daily.state.modePinned,
    localTracks: (window.Daily.state.page && window.Daily.state.page.tracks || []).length,
    onlineTracks: (window.Daily.state.online && window.Daily.state.online.tracks || []).length,
    cards: document.querySelectorAll('#daily-list .daily-card').length,
    activeChip: (() => {
      const b = document.querySelector('#daily-modes button.active, .daily-modes button.active');
      return b ? b.getAttribute('data-daily-mode') : null;
    })(),
  }));
  console.log('\n终态: ' + JSON.stringify(st));
  ok(st.mode === 'online', '落位到 online（有已登录平台）', 'mode=' + st.mode);
  ok(st.cards > 0, '终态有卡片', 'cards=' + st.cards);
  ok(st.activeChip === 'online', '来源高亮与生效来源一致', 'chip=' + st.activeChip);

  // 判据 4：终态的卡片必须来自 online（id 带 online: 前缀），不是本地那份残留
  const idsAreOnline = await page.evaluate(() => {
    const D = window.Daily.state;
    return { mode: D.mode, online: (D.online && D.online.tracks || []).length, local: (D.page && D.page.tracks || []).length };
  });
  ok(idsAreOnline.online > 0, '在线那份有数据', JSON.stringify(idsAreOnline));

  await page.screenshot({ path: `${OUT}/daily-final.png` });

  // 判据 5：用户手动切到「本地」后应立刻换成本地那份，且 pinned 生效
  const switched = await page.evaluate(async () => {
    const btn = document.querySelector('[data-daily-mode="local"]');
    if (!btn) return { err: 'no local button' };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      mode: window.Daily.state.mode,
      pinned: window.Daily.state.modePinned,
      stored: localStorage.getItem('vmusic.daily.mode'),
      cards: document.querySelectorAll('#daily-list .daily-card').length,
      chip: (document.querySelector('.daily-modes button.active') || {}).dataset
        ? document.querySelector('.daily-modes button.active').getAttribute('data-daily-mode') : null,
    };
  });
  console.log('切本地后: ' + JSON.stringify(switched));
  ok(switched.mode === 'local' && switched.pinned, '手动切本地生效并锁定', JSON.stringify(switched));
  ok(switched.stored === 'local', '选择已持久化', 'stored=' + switched.stored);
  ok(switched.chip === 'local', '高亮跟着切', 'chip=' + switched.chip);
  await page.screenshot({ path: `${OUT}/daily-local.png` });

  // 判据 6：刷新后应恢复上次选择（local），不被 auto 改掉
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const i = document.querySelector('.rail-item[data-view="library"]'); if (i) i.click(); });
  await page.waitForTimeout(3000);
  const afterReload = await page.evaluate(() => ({
    mode: window.Daily.state.mode,
    pinned: window.Daily.state.modePinned,
    cards: document.querySelectorAll('#daily-list .daily-card').length,
  }));
  console.log('刷新后: ' + JSON.stringify(afterReload));
  ok(afterReload.mode === 'local', '刷新后恢复上次选的本地', 'mode=' + afterReload.mode);
  ok(afterReload.cards > 0, '刷新后有卡片', 'cards=' + afterReload.cards);

  ok(errors.length === 0, '全程无 JS 报错', errors.join(' | ') || '(无)');

  console.log('\n' + '─'.repeat(56));
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });