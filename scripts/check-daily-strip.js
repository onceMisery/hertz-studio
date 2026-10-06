// SPDX-License-Identifier: MIT
// 首页每日推荐条到底显不显示：把 index.html 的真实结构 + style.css + daily.js
// 一起摆进离线页面，用真浏览器量「#daily-list 里有没有卡片、#daily-strip 有多高」。
//
// 为什么离线：这条只量 index.html 的接线（id 在不在、daily.js 有没有往里放卡片），
// 不需要服务、也不需要用凭据开页面（`/` 已收紧，开首页得先出示凭据，见
// scripts/ui-token.js），离线夹具更快也更稳。而这次改动的接线全在 index.html 的
// id 与 daily.js 里，两者都能离线取到 —— 量到的是同一批 id、同一份 CSS。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.SKIN_SHOT_DIR || 'output/verify-daily';
let pass = 0, fail = 0;
const failures = [];
function ok(c, n, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); } else { fail++; failures.push(n); console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } }

const ONLINE = {
  date: '2026-10-06', limit: 24, total: 3, empty: false,
  tracks: [
    { source: 'netease', id: '1', title: '云一', artist: 'N', album: '素', duration_ms: 210000, cover: null, virtual_id: 'online:netease:1', source_label: '网易云音乐' },
    { source: 'qq', id: '2', title: 'Q 一', artist: 'Q', album: '素', duration_ms: 180000, cover: null, virtual_id: 'online:qq:2', source_label: 'QQ音乐' },
    { source: 'netease', id: '3', title: '云三', artist: 'N', album: '素', duration_ms: 240000, cover: null, virtual_id: 'online:netease:3', source_label: '网易云音乐' },
  ],
  sources: [{ source: 'netease', label: '网易云音乐', count: 2 }, { source: 'qq', label: 'QQ音乐', count: 1 }],
  skipped: [{ source: 'kugou', label: '酷狗音乐', kind: 'unsupported', message: '该音源没有每日推荐歌曲接口' }],
  ready: ['网易云音乐', 'QQ音乐'], pending: [], age_secs: 0, refreshing: false,
};
const LOCAL = {
  date: '2026-10-06', total: 2, empty: false,
  tracks: [
    { id: 'l1', title: '本地一', artist: 'L', album: '素', duration_ms: 200000, has_cover: false, reasons: ['最近常听'] },
    { id: 'l2', title: '本地二', artist: 'L', album: '素', duration_ms: 220000, has_cover: false, reasons: ['评分高'] },
  ],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const styleCss = fs.readFileSync(path.join(ROOT, 'plugin/ui/style.css'), 'utf8');
  const stageCss = fs.readFileSync(path.join(ROOT, 'plugin/ui/stage.css'), 'utf8');
  const skinsCss = fs.readFileSync(path.join(ROOT, 'plugin/ui/skins/skins.css'), 'utf8');
  const dailyJs = fs.readFileSync(path.join(ROOT, 'plugin/ui/daily.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'plugin/ui/index.html'), 'utf8');

  // 只取 index.html 里 #view-library 那一段 + 图标 sprite，够 daily.js 跑。
  const sp = htmlSrc.indexOf('<svg id="icon-sprite"');
  const spEnd = htmlSrc.indexOf('</svg>', sp) + 6;
  const stripStart = htmlSrc.indexOf('<div class="daily-strip" id="daily-strip">');
  const stripEnd = htmlSrc.indexOf('</div>\n\n      <div class="lib-empty"', stripStart);
  const stripHtml = stripStart >= 0
    ? htmlSrc.slice(stripStart, htmlSrc.indexOf('<div class="lib-empty"', stripStart))
    : '<div class="daily-strip" id="daily-strip"><div class="daily-list" id="daily-list"></div></div>';

  const page_html = `<!doctype html><html lang="zh-CN" data-skin="classic"><head>
<meta charset="utf-8"><title>曲库 · 每日推荐</title>
<style>${styleCss}</style><style>${stageCss}</style><style>${skinsCss}</style>
<style>
 body{margin:0;background:#0A0A0A;color:#E8ECEF;font:14px/1.6 system-ui,sans-serif}
 .shell{padding:16px;max-width:1080px}
</style></head><body>
${htmlSrc.slice(sp, spEnd)}
<div class="shell"><div class="view" id="view-library">
  <h1 class="col-title">曲库</h1>
  ${stripHtml}
</div></div>
<script>
${dailyJs}
</script>
<script>
(function(){
  // 假 transport：在线那路用闸门扣住，模拟真实的服务端 2s 等待预算。
  var held = [];
  var ONLINE = ${JSON.stringify(ONLINE)};
  var LOCAL = ${JSON.stringify(LOCAL)};
  window.__probe = { calls: [], held: held, posts: [] };
  window.VMusicTransport = {
    get: function (p) {
      window.__probe.calls.push(p.indexOf('online') >= 0 ? 'online' : 'local');
      if (p.indexOf('online') >= 0) return new Promise(function (res) { held.push(function(){ res(ONLINE); }); });
      return Promise.resolve(LOCAL);
    },
    post: function () { return Promise.resolve({}); },
    put: function (p) { window.__probe.posts.push(p); return Promise.resolve({}); },
  };
  var ui = {
    dailyList: document.getElementById('daily-list'),
    dailyDate: document.getElementById('daily-date'),
    dailySub: document.getElementById('daily-sub'),
    dailyModes: document.getElementById('daily-modes'),
    dailyPlayAll: document.getElementById('daily-play-all'),
    dailyRefresh: document.getElementById('daily-refresh'),
  };
  var notified = [];
  window.__probe.notified = notified;
  window.Daily.bind({
    ui: ui, state: { view: 'library' },
    fmt: function (ms) { return String(Math.round((ms||0)/1000)); },
    toast: function () {}, errText: function (p) { return p; },
    coverUrl: function () { return null; },
    onDailyModeChange: function (m) { notified.push(m); },
  });
  // 与 app.js 同时序：先 init()，再由 setView('library') 触发 load()
  window.Daily.init();
  window.__probe.initRendered = ui.dailyList.children.length;
  window.Daily.load({ silent: true });
})();
</script>
</body></html>`;

  const file = path.resolve(OUT, 'daily-strip.html');
  fs.writeFileSync(file, page_html);

  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });
  await page.goto('file:///' + file.replace(/\\/g, '/'));
  await page.waitForTimeout(800);

  const m = await page.evaluate(() => {
    const strip = document.getElementById('daily-strip');
    const list = document.getElementById('daily-list');
    const sr = strip.getBoundingClientRect();
    const cs = getComputedStyle(strip);
    return {
      probe: { calls: window.__probe.calls, initRendered: window.__probe.initRendered,
        held: window.__probe.held.length, notified: window.__probe.notified },
      strip: { w: Math.round(sr.width), h: Math.round(sr.height), display: cs.display, visibility: cs.visibility, opacity: cs.opacity },
      list: { children: list.children.length, h: Math.round(list.getBoundingClientRect().height) },
      sub: (document.getElementById('daily-sub') || {}).textContent,
      date: (document.getElementById('daily-date') || {}).textContent,
      mode: window.Daily.state.mode,
      cards: [...list.querySelectorAll('.daily-name')].map((n) => n.textContent),
      playAllDisabled: (document.getElementById('daily-play-all') || {}).disabled,
      // 关键的「有没有被藏起来」判据
      stripRect: { top: Math.round(sr.top), h: Math.round(sr.height) },
      firstCardBox: (() => {
        const c = list.querySelector('.daily-card');
        if (!c) return null;
        const b = c.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), visible: b.height > 0 && b.width > 0 };
      })(),
    };
  });

  console.log('\n离线实测（真实 index.html 结构 + style.css + daily.js）：');
  console.log('  strip  ' + m.strip.w + '×' + m.strip.h + '  display=' + m.strip.display + ' opacity=' + m.strip.opacity);
  console.log('  list   ' + m.list.children + ' 个子节点，高 ' + m.list.h);
  console.log('  卡片   ' + JSON.stringify(m.cards));
  console.log('  副标题 ' + m.sub);
  console.log('  通知   ' + JSON.stringify(m.probe.notified));
  await page.screenshot({ path: path.join(OUT, 'daily-strip-local.png'), clip: { x: 0, y: 0, width: 1200, height: 420 } });

  // 判据 1：init 后 load 已发出两路
  ok(m.probe.calls.length === 2, 'load() 发出两路请求', JSON.stringify(m.probe.calls));
  // 判据 2：在线被扣住时本地已上屏
  ok(m.list.children >= 1, '在线还没回来时首页就有内容',
    `children=${m.list.children} cards=${JSON.stringify(m.cards)}`);
  ok(m.cards.length > 0, '画出了真实卡片（不是只有占位提示）', 'cards=' + m.cards.length);
  ok(m.firstCardBox && m.firstCardBox.visible, '卡片有实际尺寸（不是 0×0）',
    m.firstCardBox ? `${m.firstCardBox.w}×${m.firstCardBox.h}` : '(无)');
  // 判据 3：推荐条本身可见
  ok(m.strip.h > 40, '推荐条有高度（没被 display:none）', 'h=' + m.strip.h);
  ok(m.strip.display !== 'none' && m.strip.opacity !== '0', '推荐条是可见的',
    `display=${m.strip.display} opacity=${m.strip.opacity}`);
  // 判据 4：副标题有内容
  ok(m.sub && m.sub.length > 2, '副标题有文案', m.sub);

  // 放行在线 → 落位
  await page.evaluate(() => { window.__probe.held.forEach((f) => f()); });
  await page.waitForTimeout(600);
  const m2 = await page.evaluate(() => {
    const list = document.getElementById('daily-list');
    return {
      children: list.children.length,
      cards: [...list.querySelectorAll('.daily-name')].map((n) => n.textContent),
      sub: (document.getElementById('daily-sub') || {}).textContent,
      mode: window.Daily.state.mode,
      notified: window.__probe.notified,
      playAllDisabled: (document.getElementById('daily-play-all') || {}).disabled,
    };
  });
  console.log('\n放行在线后：');
  console.log('  ' + m2.children + ' 张 · ' + JSON.stringify(m2.cards) + ' · ' + m2.sub);
  await page.screenshot({ path: path.join(OUT, 'daily-strip-online.png'), clip: { x: 0, y: 0, width: 1200, height: 420 } });

  ok(m2.mode === 'online', '落位到 online', 'mode=' + m2.mode);
  ok(m2.cards.length === 3, '落位后是在线那 3 首', JSON.stringify(m2.cards));
  ok(m2.sub.indexOf('已合并') >= 0, '副标题是合并说明', m2.sub);
  ok(m2.playAllDisabled === false, '「播放全部」可点', 'disabled=' + m2.playAllDisabled);

  ok(errs.length === 0, '全程无 JS 报错', errs.join(' | ') || '(无)');

  console.log('\n' + '─'.repeat(50));
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });