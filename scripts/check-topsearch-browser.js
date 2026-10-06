// 顶栏在线搜索（topsearch.js）的六皮肤浏览器实测（验收脚本，非契约）。
// 逐肤验证：下拉面板出现、定位锚在输入框下方且不出视口、歌曲/歌手预览渲染、
// 档位 chips、回车跳在线页（classic 抽查）、无 JS 异常。
//
// 前置：一个跑着新前端的隔离实例（在线搜索要走真实网络，网易对同词连搜有
// code=405 风控，脚本失败会自动换词重试一次）：
//   VMUSIC_BACKEND=null ./target-verify/debug/hertz-studio.exe --port 7831 --data-dir output/<目录>/data
// 用法：TS_DATA_DIR=output/<目录>/data node scripts/check-topsearch-browser.js
//   TS_BASE（默认 7831）、TS_SKINS（逗号分隔子集，如 qingfeng）可覆盖。
// 依赖 playwright 可解析（本机用 @playwright/cli 的 shim，见 output/ 历史）。
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.TS_BASE || 'http://127.0.0.1:7831';
const DATA_DIR = process.env.TS_DATA_DIR;
if (!DATA_DIR) {
  console.error('需要 TS_DATA_DIR（隔离实例的数据目录，里面要有 token 文件）');
  process.exit(1);
}
const TOKEN = fs
  .readFileSync(path.join(DATA_DIR, 'token'), 'utf8')
  .trim();
const OUT = process.env.TS_OUT || path.resolve(__dirname, '..', 'output', 'topsearch-shots');
fs.mkdirSync(OUT, { recursive: true });

const SKINS = (process.env.TS_SKINS || 'classic,sheen,workbench,liunian,ios,qingfeng').split(',');

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok  ' + label + (extra ? '  (' + extra + ')' : ''));
  else {
    failures += 1;
    console.error('  X   ' + label + (extra ? '  (' + extra + ')' : ''));
  }
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const isExpected401 = (t) => /status of 401/.test(t);
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => {
    // "Failed to load resource" 是网络层的重述（502 已由 response 日志单独报），
    // 真正的 JS 异常走 pageerror，这里只收其它 console error。
    if (m.type() === 'error' && !isExpected401(m.text()) && !/Failed to load resource/.test(m.text()))
      errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.url().includes('/v1/online/') && r.url().includes('search') && !r.ok())
      console.log('  .. 搜索接口 ' + r.status() + ' ' + r.url().split('?')[0]);
  });

  // 敲词等预览。网易对同词连搜有风控（code=405，隔一会自行解禁），
  // 失败时换关键词清空重输——state.q 变回空再变来才会触发新一轮预览。
  const typeAndPreview = async (q) => {
    await page.click('#search');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const word = attempt === 1 ? q : q === '周杰伦' ? '林俊杰' : q;
      await page.keyboard.type(word, { delay: 120 });
      try {
        await page.waitForSelector('.ts-menu .ts-row', { timeout: 15000 });
        return word;
      } catch (e) {
        const hint = await page
          .$eval('.ts-body', (el) => el.textContent.slice(0, 100))
          .catch(() => '(面板已关)');
        console.log('  .. 第' + attempt + '次未出结果，hint=' + hint);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(1500);
      }
    }
    return null;
  };

  for (const skin of SKINS) {
    console.log('\n== 皮肤 ' + skin + ' ==');
    errors.length = 0;
    await page.goto(BASE + '/?token=' + TOKEN, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        window.TopSearch &&
        window.Skins &&
        window.Online &&
        window.Online.sources &&
        window.Online.sources().length > 0,
      { timeout: 30000 }
    );
    await page.evaluate((id) => window.Skins.apply(id), skin);
    await page.waitForTimeout(400);

    // sheen 摘掉了常驻搜索框，走真实用户路径：`/` 快捷键唤起。
    if (skin === 'sheen') {
      await page.keyboard.press('/');
      await page.waitForTimeout(200);
      const revealed = await page.evaluate(() =>
        document.body.classList.contains('sheen-search')
      );
      ok(revealed, 'sheen: `/` 快捷键挂上 sheen-search 标记');
    }

    await page.click('#search');
    await page.waitForSelector('.ts-menu:not([hidden])', { timeout: 5000 });
    const chips = await page.$$eval('.ts-chip', (els) =>
      els.map((e) => e.dataset.kind)
    );
    ok(
      JSON.stringify(chips) ===
        JSON.stringify(['song', 'playlist', 'artist', 'album', 'local']),
      '五档 chips 齐全',
      chips.join(',')
    );

    // 歌曲预览
    const songWord = await typeAndPreview('周杰伦');
    ok(!!songWord, '歌曲预览渲染');
    if (songWord) {
      const songRows = await page.$$eval('.ts-row', (els) => els.length);
      ok(songRows > 0, '歌曲预览行数', songRows + ' 行');

      // 几何：面板顶边 = 输入框底边 + 8，左右不出视口
      const geo = await page.evaluate(() => {
        const m = document.querySelector('.ts-menu').getBoundingClientRect();
        const i = document.getElementById('search').getBoundingClientRect();
        return {
          top: m.top,
          expectTop: i.bottom + 8,
          left: m.left,
          right: m.right,
          width: m.width,
          vw: window.innerWidth,
        };
      });
      ok(
        Math.abs(geo.top - geo.expectTop) <= 3,
        '面板锚在输入框下方 +8px',
        'top=' + geo.top.toFixed(0) + ' expect=' + geo.expectTop.toFixed(0)
      );
      ok(geo.left >= 0 && geo.right <= geo.vw, '面板不出视口', `left=${geo.left.toFixed(0)} right=${geo.right.toFixed(0)} vw=${geo.vw}`);
      ok(geo.width >= 380 && geo.width <= 480, '面板宽度在 380–480', String(Math.round(geo.width)));
      await page.screenshot({ path: path.join(OUT, skin + '-song.png') });
    }

    // 歌手预览（chips 切档 + 卡片网格）。setKind 同档是空操作，重试要绕道
    // 歌曲档再切回来。
    let artistOk = false;
    for (let attempt = 1; attempt <= 2 && !artistOk; attempt += 1) {
      await page.click('.ts-chip[data-kind="artist"]');
      try {
        await page.waitForSelector('.ts-menu .ts-cards .ts-card', { timeout: 15000 });
        artistOk = true;
      } catch (e) {
        console.log('  .. 歌手预览第' + attempt + '次未出卡片，绕道重切');
        await page.click('.ts-chip[data-kind="song"]');
        await page.waitForTimeout(1500);
      }
    }
    ok(artistOk, '歌手预览卡片渲染');
    if (artistOk) {
      const artistCards = await page.$$eval('.ts-card', (els) => els.length);
      ok(artistCards > 0, '歌手预览卡片数', artistCards + ' 张');
      await page.screenshot({ path: path.join(OUT, skin + '-artist.png') });
    }

    // Esc 收起
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const closed = await page.evaluate(() => window.TopSearch.isOpen() === false);
    ok(closed, 'Esc 收起面板');

    ok(errors.length === 0, '无 JS 异常', errors.slice(0, 2).join(' | '));
    await page.waitForTimeout(2500); // 皮肤之间放慢一点，减轻同词连搜的风控压力
  }

  // classic 抽查：回车跳在线页 + 本地档。重新加载——上面循环把 kind 留在了
  // 歌手档，顶栏搜索与在线页共用 state，不重置会把预览打到错误档位。
  console.log('\n== 交互语义（classic） ==');
  errors.length = 0;
  await page.goto(BASE + '/?token=' + TOKEN, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.TopSearch && window.Online && window.Online.sources().length > 0,
    { timeout: 30000 }
  );
  await page.evaluate(() => window.Skins.apply('classic'));
  const jumpWord = await typeAndPreview('周杰伦');
  ok(!!jumpWord, '歌曲预览渲染（回车前置）');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (w) => window.Online && window.Online.state && window.Online.state.q === w,
    jumpWord,
    { timeout: 10000 }
  );
  const onlineKind = await page.evaluate(() => window.Online.state.kind);
  ok(onlineKind === 'song', '回车写回在线页 q 且 kind=song', 'kind=' + onlineKind);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'classic-online-jump.png') });

  // 本地档：placeholder 换文案、面板收起、输入触发本地筛选
  await page.click('#search');
  await page.click('.ts-chip[data-kind="local"]');
  await page.waitForTimeout(200);
  const ph = await page.$eval('#search', (el) => el.placeholder);
  ok(/本地曲库/.test(ph), '本地档 placeholder 切换', ph);
  const localOpen = await page.evaluate(() => window.TopSearch.isOpen());
  ok(!localOpen, '切本地档收起面板');
  await page.keyboard.type('周', { delay: 60 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'classic-local.png') });
  ok(errors.length === 0, '无 JS 异常', errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(
    '\n────────\n' +
      (failures ? failures + ' 项失败' : '全部通过') +
      '，截图在 ' + OUT
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
