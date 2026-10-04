// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 浏览器类检查的前置自检：node scripts/check-browser-preflight.js
//
// 为什么需要它：6 个 browser 检查此前的失败方式非常糟糕 —— 环境不具备时它们
// 不是快速失败，而是挂在 page.goto 上直到整个命令被 SIGTERM（看不出是"环境问题"
// 还是"功能坏了"）。这个脚本把三件事拆开各自快速报结论：
//
//   1) playwright 包在不在（require 得到吗）
//   2) 系统 Chrome 能不能被拉起（launch + setContent，不碰网络）
//   3) Chrome 能不能访问本机 HTTP 服务（这一步最可能挂死，所以单独设短超时）
//
// 第 3 项是本机沙箱的已知限制：Chrome 子进程访问 127.0.0.1 会被卡住，
// 而 curl 访问同一地址正常。所以即使前两项都过，第 3 项也可能失败 ——
// 此时 browser 检查应当跳过并如实说明，而不是被当成产品缺陷。
'use strict';
const path = require('path');
const http = require('http');

const PORT = process.env.STAGE_PORT || '7634';
// 挂死是这个脚本要治的病，所以每个探测都给一个明确的短超时。
const LAUNCH_TIMEOUT = 20000;
const NAV_TIMEOUT = 8000;

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures += 1; console.error('FAIL:', msg); } else console.log('ok -', msg);
}
function info(msg) { console.log('     ' + msg); }

// ---------------------------------------------------------------------------
// 1) playwright 包
let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
  ok(true, 'playwright 可 require');
} catch (e) {
  ok(false, 'playwright 可 require');
  info('装法（本项目零依赖，装到托管 workspace 而不是仓库里）：');
  info('  npm --prefix "%USERPROFILE%/.workbuddy/binaries/node/workspace" install playwright');
  info('跑 browser 检查时带上 NODE_PATH=<上面那个目录>/node_modules');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2) Chrome 能否拉起并渲染（不碰网络，用 setContent）
let browser = null;
(async () => {
  try {
    browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, timeout: LAUNCH_TIMEOUT
    });
    ok(true, '系统 Chrome 可启动（channel=chrome）');
  } catch (e) {
    // channel=chrome 需要真装的 Chrome；没有的话回落到 playwright 自带的 chromium。
    info('channel=chrome 失败（' + String(e.message).split('\n')[0].slice(0, 80) + '），回落自带 chromium');
    try {
      browser = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT });
      ok(true, 'playwright 自带 chromium 可启动（改用 PLAYWRIGHT_CHANNEL=空 生效）');
    } catch (e2) {
      ok(false, '没有任何可用 Chrome');
      info('装一个：npx -y playwright@latest install chromium');
      process.exit(2);
    }
  }

  const page = await browser.newPage();
  try {
    await page.setContent('<div id="probe">ok</div>', { timeout: LAUNCH_TIMEOUT });
    const t = await page.textContent('#probe');
    ok(t === 'ok', '渲染与 evaluate 可用');
  } catch (e) {
    ok(false, '渲染与 evaluate 可用');
    info(String(e.message).split('\n')[0].slice(0, 100));
    await browser.close();
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // 3) Chrome 能否访问本机服务（关键项，单独设短超时）
  const alive = await probeHttp(PORT);
  if (!alive) {
    ok(false, '服务在 127.0.0.1:' + PORT + ' 可访问（curl 侧）');
    info('先起服务：./target/debug/hertz-studio.exe --port ' + PORT);
    await browser.close();
    process.exit(2);
  }
  ok(true, '服务在 127.0.0.1:' + PORT + ' 可访问（curl 侧）');

  const viaBrowser = await probeBrowser(page, PORT);
  if (viaBrowser.ok) {
    ok(true, 'Chrome 可访问本机服务（browser 类检查可以跑）');
  } else {
    ok(false, 'Chrome 可访问本机服务（browser 类检查可以跑）');
    info('原因：' + viaBrowser.why);
    info('这是本机沙箱的已知限制 —— Chrome 子进程访问 loopback 被卡住，curl 却正常。');
    info('因此 6 个 browser 检查在此环境下应视为「不可运行」，不是「功能失败」。');
    info('要跑真实渲染回归，请在沙箱外用 IDE 内置浏览器或放开 Chrome 的 loopback 权限。');
  }

  await browser.close();
  console.log('\n' + (failures
    ? '前置自检 ' + failures + ' 项不通过：browser 类检查本轮跳过。'
    : '前置自检全部通过：6 个 browser 检查可以跑。'));
  // 只要 loopback 这项没过就以 2 退出（约定为"环境不具备"），让 CI/本地都能区分。
  process.exit(failures ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: port, path: '/v1/health', timeout: 4000 }, (res) => {
      res.resume(); resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function probeBrowser(page, port) {
  try {
    const r = await page.goto('http://127.0.0.1:' + port + '/v1/health',
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    return { ok: r && r.status() > 0 };
  } catch (e) {
    return { ok: false, why: String(e.message).split('\n')[0].slice(0, 90) };
  }
}
