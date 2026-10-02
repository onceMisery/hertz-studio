// SPDX-License-Identifier: MIT
// Run with SEARCH_UI_URL pointing to an isolated service. Requires Playwright.
// PLAYWRIGHT_MODULE may point to an existing installation. No real playback is sent.
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
async function check(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseQQ;
  const slowQQ = new Promise(resolve => { releaseQQ = resolve; });
  let playReply;
  let playCalls = 0;
  const requests = [];
  await page.route('**/v1/online/search?**', async route => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source');
    const offset = Number(url.searchParams.get('offset'));
    requests.push({ source, offset });
    if (source === 'qq') await slowQQ;
    if (source === 'kugou') return route.fulfill({ status: 400, json: { error: { message: '音源暂时不可用，请重试' } } });
    const count = ['netease', 'qq'].includes(source) ? offset ? 2 : Number(url.searchParams.get('limit')) : 0;
    await route.fulfill({ json: { total: 999, tracks: Array.from({ length: count }, (_, i) => ({
      source, id: String(offset + i), title: source === 'qq' ? '晴天' : '晴天 · Live 现场版',
      artist: '周杰伦', album: '叶惠美', duration_ms: 269000,
      playable: true, vip_only: i % 4 === 0, cover: i === 0 ? '/missing-cover-fixture.jpg' : null,
    })) } });
  });
  await page.route('**/v1/online/play', async route => {
    playCalls++;
    if (playCalls > 1) {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { track_ids: body.tracks.map(track => 'online:' + body.source + ':' + track.id), index: body.index } });
    }
    await new Promise(resolve => { playReply = resolve; });
    await route.fulfill({ status: 403, json: { error: { message: '此版本暂不可播放，请选择其他来源' } } });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('combobox', { name: '音源', exact: true }).selectOption('all');
    await page.getByRole('searchbox', { name: '搜索在线曲库' }).fill('晴天');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.waitForFunction(() => Online.state.tracks.length === 20 && Online.state.loading);
    await page.screenshot({ path: 'output/playwright/search-progressive.png' });
    await page.getByRole('button', { name: /QQ音乐 · 0/ }).click();
    await page.locator('.search-skeleton').first().waitFor();
    await page.screenshot({ path: 'output/playwright/search-skeleton.png' });
    releaseQQ();
    await page.waitForFunction(() => !Online.state.loading && Online.state.tracks.length === 40);
    await page.getByRole('button', { name: '综合 · 40', exact: true }).click();
    if (!(await page.locator('.online-row').first().getAttribute('data-online-id')).startsWith('online:qq:')) throw new Error('Exact title should rank first');
    await page.screenshot({ path: 'output/playwright/search-desktop.png' });
    await page.locator('.search-source-status').filter({ hasText: '网易云音乐' }).getByRole('button', { name: '加载更多' }).click();
    await page.waitForFunction(() => Online.state.tracks.length === 42);
    if (requests.filter(r => r.source === 'netease' && r.offset === 20).length !== 1) throw new Error('Pagination offset incorrect');
    await page.getByRole('button', { name: /QQ音乐 · 20/ }).click();
    const play = page.locator('.online-row').first().getByRole('button', { name: '在线试听', exact: true });
    await play.click();
    await page.locator('.online-row.is-loading').waitFor();
    await page.locator('.online-row.is-loading').getByRole('button', { name: '正在加载歌曲' }).click();
    if (playCalls !== 1) throw new Error('Duplicate play request');
    await page.screenshot({ path: 'output/playwright/search-play-loading.png' });
    playReply();
    await page.locator('.online-row.has-play-error').waitFor();
    await page.screenshot({ path: 'output/playwright/search-play-error.png' });
    await page.locator('.online-row.has-play-error').getByRole('button', { name: '播放失败，点击重试' }).click();
    await page.waitForFunction(() => !document.querySelector('.online-row.has-play-error, .online-row.is-loading'));
    if (playCalls !== 2) throw new Error('Row retry did not submit playback');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: `output/playwright/search-mobile-${width}.png` });
      const overflow = await page.locator('.online-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      if (overflow) {
        console.log(await page.locator('.online-scroll').evaluate(el => ({
          width: el.clientWidth, scroll: el.scrollWidth,
          overflowing: [...el.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
            .slice(0, 16).map(child => ({ cls: child.className, right: child.getBoundingClientRect().right })),
        })));
        throw new Error('Search overflows at ' + width);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('searchbox', { name: '搜索在线曲库' }).fill('');
    if (await page.locator('.online-row').count()) throw new Error('Clearing search retained stale rows');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Browser checks passed: partial results, skeletons, ranking, paging, duplicate play, retry feedback, 320/390px overflow, clearing.');
  } finally {
    releaseQQ();
    if (playReply) playReply();
    await page.unroute('**/v1/online/search?**');
    await page.unroute('**/v1/online/play');
  }
}

(async () => {
  fs.mkdirSync('output/playwright', { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    if (process.env.SEARCH_LOCAL_ASSETS === '1') {
      for (const file of ['online.css', 'online.js', 'app.js']) {
        await page.route('**/' + file, route => route.fulfill({
          contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript',
          body: fs.readFileSync('plugin/ui/' + file, 'utf8'),
        }));
      }
    }
    await page.goto(process.env.SEARCH_UI_URL || 'http://127.0.0.1:18766');
    await page.getByRole('button', { name: '在线曲库', exact: true }).click();
    await check(page);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
