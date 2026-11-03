'use strict';

// R1 外壳导航冒烟：真实页面上验证活动视图、工作区模式与公共区域显隐归外壳所有。
// SHELL_UI_URL=http://127.0.0.1:18781 VMUSIC_DATA_DIR=<隔离数据目录>
// PLAYWRIGHT_MODULE=<playwright module> node scripts/check-shell-navigation-browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiToken, uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/shell');
const base = process.env.SHELL_UI_URL || 'http://127.0.0.1:18781';
const token = uiToken();
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
async function api(method, endpoint, body) {
  const response = await fetch(base + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function workspaceAssets(route) {
  const url = new URL(route.request().url());
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
  const file = path.resolve(web, relative);
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  let body = fs.readFileSync(file);
  if (relative === 'index.html') body = body.toString().replace('__VMUSIC_TOKEN_VALUE__', token);
  return route.fulfill({ body, contentType: types[path.extname(file)] || 'application/octet-stream' });
}
const pageErrors = [];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  check((await api('GET', '/v1/health')).backend === 'null', 'isolated silent backend');

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  // Workspace routing makes Chrome request local-network permission for WS.
  await context.grantPermissions(['local-network-access'], { origin: base });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.route(base + '/**', workspaceAssets);

  // 1. 启动落位：外壳持有活动视图，显隐与导航选中态一致。
  await page.goto(uiUrl(base));
  await page.waitForFunction(() => window.HertzShell && window.HertzShell.activeView());
  await page.waitForFunction(() => document.getElementById('conn') && document.getElementById('conn').textContent === '服务已连接');
  const boot = await page.evaluate(() => ({
    active: window.HertzShell.activeView(),
    mode: window.HertzShell.mode(),
    hidden: Object.fromEntries(['library', 'online', 'room', 'settings'].map((id) => [id, document.getElementById('view-' + id).hidden])),
    railActive: document.querySelector('.rail-item.active') && document.querySelector('.rail-item.active').dataset.view,
    roomView: document.body.classList.contains('room-view'),
    generation: window.HertzShell.generation(),
  }));
  check(boot.active === 'online', `启动落位默认在线曲库（实得 ${boot.active}）`);
  check(boot.mode === 'default' && boot.roomView === false, '启动为普通工作区模式');
  check(boot.hidden.online === false && boot.hidden.library === true && boot.hidden.room === true, '视图 hidden 对账正确');
  check(boot.railActive === 'online', '导航选中态与活动视图一致');

  // 2. 房间工作区：进入后公共 chrome 隐藏、外壳模式切房间。
  await page.click('.rail-item[data-view="room"]');
  await page.waitForFunction(() => window.HertzShell.activeView() === 'room');
  const roomEnter = await page.evaluate(() => ({
    mode: window.HertzShell.mode(),
    roomView: document.body.classList.contains('room-view'),
    topbarDisplay: getComputedStyle(document.querySelector('.topbar')).display,
    railDisplay: getComputedStyle(document.getElementById('rail')).display,
    barDisplay: getComputedStyle(document.getElementById('playback-bar')).display,
    roomHidden: document.getElementById('view-room').hidden,
    workspaceMounted: !!document.querySelector('#view-room .room-workspace'),
    floatingMount: !!document.querySelector('.shell-region-floating > #room-global-player'),
  }));
  check(roomEnter.mode === 'room' && roomEnter.roomView === true, '外壳切换到房间工作区模式');
  check(roomEnter.topbarDisplay === 'none' && roomEnter.railDisplay === 'none' && roomEnter.barDisplay === 'none',
    '房间模式下顶栏/导航/播放条由外壳层隐藏');
  check(roomEnter.roomHidden === false && roomEnter.workspaceMounted, '房间工作区已挂载且可见');
  check(roomEnter.floatingMount, '页面外迷你播放条装配在外壳浮动区域');

  // 3. 房间中换肤：换肤广播让外壳重跑落位（既有契约：换完一律落到默认视图并
  //    重跑进入对账）；房间会话不重建，公共 chrome 归属始终由外壳统一决定。
  for (const skin of ['qingfeng', 'classic', 'orbit']) {
    await page.evaluate((id) => window.Skins.apply(id), skin);
    await page.waitForFunction((id) => document.documentElement.dataset.skin === id, skin);
    const skinRoom = await page.evaluate(() => ({
      active: window.HertzShell.activeView(),
      roomView: document.body.classList.contains('room-view'),
      topbarDisplay: getComputedStyle(document.querySelector('.topbar')).display,
      workspaceMounted: !!document.querySelector('#view-room .room-workspace'),
    }));
    check(skinRoom.active === 'online' && skinRoom.roomView === false && skinRoom.topbarDisplay !== 'none',
      `房间中切到 ${skin} 皮肤：外壳按契约重新落位默认视图，chrome 恢复`);
    check(skinRoom.workspaceMounted, `切到 ${skin} 皮肤后房间会话未被重建`);
  }

  // 3b. 皮肤下的房间工作区：外壳的模式布局规则对 html[data-skin] 同样成立。
  await page.evaluate(() => window.Skins.apply('qingfeng'));
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'qingfeng');
  // 清风把 rail 换成胶囊导航（rail 不可点），页面请求切页走外壳 API。
  await page.evaluate(() => window.HertzShell.navigate('room'));
  await page.waitForFunction(() => window.HertzShell.activeView() === 'room');
  const skinLayout = await page.evaluate(() => ({
    roomView: document.body.classList.contains('room-view'),
    appColumns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ').length,
    roomHidden: document.getElementById('view-room').hidden,
  }));
  check(skinLayout.roomView === true && skinLayout.appColumns === 1 && skinLayout.roomHidden === false,
    '清风皮肤下房间工作区单列占满（外壳层规则对皮肤生效）');
  await page.evaluate(() => window.Skins.apply('orbit'));
  await page.waitForFunction(() => document.documentElement.dataset.skin === 'orbit');

  // 4. 退出房间：公共 chrome 恢复，房间会话外壳侧仅归还展示权。
  //    （房间模式下 rail 被外壳隐藏，切页走外壳 API —— 与页面请求路径一致。）
  await page.evaluate(() => window.HertzShell.navigate('room'));
  await page.waitForFunction(() => window.HertzShell.activeView() === 'room');
  await page.evaluate(() => window.HertzShell.navigate('library'));
  await page.waitForFunction(() => window.HertzShell.activeView() === 'library');
  const roomExit = await page.evaluate(() => ({
    roomView: document.body.classList.contains('room-view'),
    topbarDisplay: getComputedStyle(document.querySelector('.topbar')).display,
    railDisplay: getComputedStyle(document.getElementById('rail')).display,
    barDisplay: getComputedStyle(document.getElementById('playback-bar')).display,
    roomHidden: document.getElementById('view-room').hidden,
  }));
  check(roomExit.roomView === false, '退出房间后工作区模式回到普通');
  check(roomExit.topbarDisplay !== 'none' && roomExit.railDisplay !== 'none' && roomExit.barDisplay !== 'none',
    '退出房间后顶栏/导航/播放条恢复');

  // 5. 无效导航不提交：外壳保持当前页面。
  const invalid = await page.evaluate(() => {
    const before = { active: window.HertzShell.activeView(), gen: window.HertzShell.generation() };
    const ok = window.HertzShell.navigate('nonexistent-view');
    return { ok, after: { active: window.HertzShell.activeView(), gen: window.HertzShell.generation() }, before };
  });
  check(invalid.ok === false, '未知视图请求被外壳拒绝');
  check(invalid.before.active === invalid.after.active && invalid.before.gen === invalid.after.gen,
    '无效导航未提交任何状态变化');

  // 6. 同名重复导航重跑进入对账（换肤/Esc 依赖的语义）。
  const reenter = await page.evaluate(() => {
    const gen = window.HertzShell.generation();
    window.HertzShell.navigate('library');
    return { committed: window.HertzShell.activeView() === 'library', genAdvanced: window.HertzShell.generation() === gen + 1 };
  });
  check(reenter.committed && reenter.genAdvanced, '同名导航重跑对账并推进代次');

  // 7. 设置页入口：外壳维护顶栏设置钮选中态（orbit 皮肤下该钮不可见，
  //    故用外壳 API 进入；属性状态仍由外壳维护）。
  await page.evaluate(() => window.HertzShell.navigate('settings'));
  await page.waitForFunction(() => window.HertzShell.activeView() === 'settings');
  const settingsState = await page.evaluate(() => ({
    pressed: document.getElementById('settings-entry').getAttribute('aria-pressed'),
    active: document.getElementById('settings-entry').classList.contains('active'),
    railActive: document.querySelector('.rail-item.active') && document.querySelector('.rail-item.active').dataset.view,
  }));
  check(settingsState.pressed === 'true' && settingsState.active, '设置钮 aria-pressed/active 由外壳维护');
  check(settingsState.railActive === 'settings', 'rail 选中态跟随设置视图');

  // 8. 键盘快捷键与 Esc 对账仍走外壳（设置页的输入框会吞按键，先失焦）。
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('1');
  await page.waitForFunction(() => window.HertzShell.activeView() === 'library');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.HertzShell.activeView() === 'library');
  check(true, '快捷键 1 与 Esc 对账后仍落在曲库');

  // 9. 播放条 pin/restore（外壳不得干扰其自有状态机）。
  await page.click('#bar-pin-toggle');
  await page.waitForFunction(() => document.getElementById('playback-bar').classList.contains('is-hidden'));
  const barHidden = await page.evaluate(() => ({
    restoreVisible: !document.getElementById('bar-restore').hidden,
  }));
  check(barHidden.restoreVisible, '播放条收起后恢复按钮可见');
  await page.click('#bar-restore');
  await page.waitForFunction(() => !document.getElementById('playback-bar').classList.contains('is-hidden'));
  check(true, '播放条恢复');

  // 10. 截图存证 + 启动期无脚本异常（摘除类改动必须全页启动冒烟）。
  await page.screenshot({ path: path.join(output, 'shell-library.png') });
  check(pageErrors.length === 0, `页面零未捕获异常（实得 ${pageErrors.length}：${pageErrors.slice(0, 3).join(' | ')}）`);

  await browser.close();
  console.log(`\n外壳导航冒烟：${checks} 项全部通过`);
})().catch((error) => { console.error('FAIL ' + error.message); process.exit(1); });
