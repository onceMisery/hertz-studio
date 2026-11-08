#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 三维空间登录弹窗的四条呈现契约（真实 DOM + 真实 shipped 模块，全部本地 fixture）：
//   1. 顶栏头像在 hertz 皮肤下仍是小圆头像，不被皮肤的 `background` 简写冲掉
//      cover / center / no-repeat（冲掉的话原图按像素铺开，只露一角）；
//   2. 每个音源行前面都有平台徽标，且重建音源条后不丢；
//   3. 已登录平台一进来就是「已接入」+ 连上线的状态，端口实心；
//   4. 选到未登录平台默认出二维码，且上一个平台的账号面板被清干净。
// 不需要运行中的服务：页面由 index.html 的登录弹窗切片 + 三个 CSS + 模块拼成。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'plugin/ui', f), 'utf8');
const html = read('index.html');
const from = html.indexOf('<div id="qr-modal"');
const to = html.indexOf('\n<!-- 播放控制弹窗', from);
assert.ok(from >= 0 && to > from, 'shipped login markup exists');
const modalMarkup = html.slice(from, to);

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(
      // 纯 DOM fixture 没有主题表，补上两层真正会被消费的令牌，让端口颜色
      // 这类「用户能感知的量」在离线环境里也能算出来（真页面由 style.css 给）。
      // sp-open 是三维空间打开后的真实状态，少了它 .sp 是 visibility:hidden，
      // 所有真实鼠标点击都会被 actionability 判成「不可见」。
      '<div class="sp sp-open" id="space3d" style="--bg:#0d0d10;--sp-accent:#5eead4">'
      + '<div class="sp-head"><button class="sp-head-btn" id="sp-account"><svg viewBox="0 0 24 24"></svg></button></div>'
      + '<div id="space-root"><main id="sp-home"></main></div></div>'
      + '<span class="iconbtn-face" id="online-account-face"></span><span id="online-account-dot"></span>'
      + modalMarkup
    );
    for (const f of ['style.css', 'online.css', 'space3d.css']) await page.addStyleTag({ content: read(f) });
    // 皮肤标记写在 html 上；hertz 皮肤那条 :is() 规则的特异性正是本回归的起因。
    await page.evaluate(() => { document.documentElement.dataset.skin = 'hertz'; });
    await page.evaluate(() => {
      const avatar = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="160"><rect width="256" height="160" fill="#4af"/><circle cx="200" cy="120" r="40" fill="#fc0"/></svg>');
      window.calls = [];
      window.VMusicTransport = {
        async get(url) {
          if (url.endsWith('/sources')) return { sources: [
            { id: 'netease', label: '网易云音乐', caps: ['qr_login', 'cookie_login'], login: { site: 'https://music.163.com', keys: ['MUSIC_U'] } },
            { id: 'qq', label: 'QQ音乐', caps: ['qr_login', 'cookie_login'], login: { site: 'https://y.qq.com', keys: ['uin'] } },
            { id: 'migu', label: '咪咕音乐', caps: ['cookie_login'], login: { site: 'https://music.migu.cn', keys: ['token'] } },
          ] };
          if (url.includes('/account?source=netease')) return { source: 'netease', nickname: '小小肖一直很黑', avatar };
          if (url.includes('/account?')) throw { status: 401, code: 'auth_required' };
          if (url.includes('/qr/poll')) return { state: 'waiting' };
          return {};
        },
        async put() {},
        async post(url, body) {
          calls.push({ url, body });
          if (url.endsWith('/qr/start')) return { ticket: 'fixture-' + body.source, poll_ms: 60000,
            qr_image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#fff"/><text x="10" y="90">QR</text></svg>') };
          return { ok: true };
        },
      };
      window.Online = {
        safeCoverUrl: u => u,
        badge: (id, label) => {
          const s = document.createElement('span');
          s.className = 'src-badge is-img';
          s.innerHTML = '<img src="/platform-icons/' + id + '.png" alt="" aria-hidden="true">';
          s.title = label || id;
          return s;
        },
      };
      window.HertzCovers = {
        applyBg: (el, url) => { el.style.backgroundImage = url ? 'url("' + url + '")' : ''; },
        applyImg: (img, url) => { if (url) img.src = url; else img.removeAttribute('src'); },
      };
    });
    await page.addScriptTag({ content: read('online-login.js') });
    await page.evaluate(() => OnlineLogin.open(null, {
      container: document.getElementById('space-root'), presentation: 'space',
    }));
    await page.waitForSelector('.qr-space .qr-source');

    // 1. 头像：量用户真正看得见的尺寸 + 计算值，而不是只看 CSS 规则文本。
    const face = await page.locator('#sp-account').evaluate(node => {
      const c = getComputedStyle(node), r = node.getBoundingClientRect();
      return { width: r.width, height: r.height, radius: c.borderRadius,
        size: c.backgroundSize, position: c.backgroundPosition, repeat: c.backgroundRepeat,
        hasImage: c.backgroundImage !== 'none' };
    });
    assert.ok(face.hasImage, 'logged-in avatar is actually painted');
    assert.ok(face.width <= 36 && face.height <= 36, 'avatar stays a compact top-bar chip: ' + JSON.stringify(face));
    assert.equal(face.radius, '50%', 'avatar is circular');
    assert.equal(face.size, 'cover', 'skin background shorthand must not reset background-size');
    assert.equal(face.position, '50% 50%', 'skin background shorthand must not reset background-position');
    assert.equal(face.repeat, 'no-repeat', 'skin background shorthand must not reset background-repeat');

    // 2. 每个音源行前面都有平台徽标。
    const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.qr-source')).map(row => ({
      source: row.dataset.source,
      first: row.firstElementChild && row.firstElementChild.className,
      label: row.textContent.trim().slice(0, 24),
    })));
    assert.equal(badges.length, 3);
    assert.ok(badges.every(b => /src-badge|qs-brand-fallback/.test(b.first || '')), 'platform badge is the first child of every row: ' + JSON.stringify(badges));
    assert.ok(badges.every(b => b.label.length > 1), 'label survives alongside the badge');

    // 3. 已登录平台一进来就接上：hub 文案、连线路径、实心端口。
    const connected = await page.evaluate(() => {
      const inPort = document.querySelector('.qr-source.is-in .qs-out');
      const outPort = document.querySelector('.qr-source:not(.is-in) .qs-out');
      return {
        hub: document.querySelector('.qs-connection').textContent,
        link: document.querySelector('.qs-link').getAttribute('d'),
        graphConnected: document.querySelector('.qs-graph').classList.contains('is-connected'),
        signedIn: document.querySelector('.qs-graph').classList.contains('is-signed-in'),
        loggedPort: getComputedStyle(inPort).backgroundColor,
        guestPort: getComputedStyle(outPort).backgroundColor,
      };
    });
    assert.ok(connected.hub.includes('网易云音乐') && connected.hub.includes('已接入'), 'logged-in source is announced as connected: ' + connected.hub);
    assert.ok(connected.link && connected.link.startsWith('M'), 'connection curve is drawn on open');
    assert.equal(connected.graphConnected, true);
    assert.equal(connected.signedIn, true);
    assert.notEqual(connected.loggedPort, connected.guestPort, 'logged-in port is visually solid, guest port stays hollow');

    // 4. 切到未登录的 QQ：默认出码，且网易云的账号面板整块消失。
    assert.equal(await page.locator('.qr-logged-in').count(), 1, 'logged-in account panel shown before switching');
    await page.locator('.qr-source[data-source="qq"]').click();
    await page.waitForSelector('#qr-canvas :is(svg,img)', { timeout: 5000 });
    const switched = await page.evaluate(() => ({
      hub: document.querySelector('.qs-connection').textContent,
      title: document.getElementById('qr-title').textContent,
      status: document.getElementById('qr-status').textContent,
      loggedPanels: document.querySelectorAll('.qr-logged-in').length,
      active: document.querySelector('.qr-source.active').dataset.source,
      starts: window.calls.filter(c => c.url.endsWith('/qr/start')).map(c => c.body.source),
      badges: Array.from(document.querySelectorAll('.qr-source')).filter(r => /src-badge|qs-brand-fallback/.test(r.firstElementChild?.className || '')).length,
    }));
    assert.ok(switched.hub.includes('QQ音乐'), 'hub follows the selected source: ' + switched.hub);
    assert.equal(switched.title, 'QQ音乐 登录');
    assert.equal(switched.loggedPanels, 0, 'previous platform account panel is cleared');
    assert.equal(switched.active, 'qq');
    assert.deepEqual(switched.starts, ['qq'], 'QR is fetched without an extra "开始登录" click');
    assert.ok(switched.status.includes('扫码'), 'status tells the user to scan');
    assert.equal(switched.badges, 3, 'rebuilding source tabs keeps every badge');

    // 切回已登录源：账号面板回来，二维码不残留。
    await page.locator('.qr-source[data-source="netease"]').click();
    await page.waitForSelector('.qr-logged-in');
    const back = await page.evaluate(() => ({
      hub: document.querySelector('.qs-connection').textContent,
      title: document.getElementById('qr-title').textContent,
      // 二维码是 #qr-canvas 的直接子节点；账号头像在 .qr-logged-in 里面，不算。
      qr: document.querySelectorAll('#qr-canvas > img, #qr-canvas > svg').length,
    }));
    assert.ok(back.hub.includes('网易云音乐'), 'switching back restores the connected platform');
    assert.equal(back.title, '网易云音乐');
    assert.equal(back.qr, 0, 'no stale QR code on a logged-in platform');

    assert.deepEqual(errors, [], 'no uncaught page errors');
    await page.close();
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
