// SPDX-License-Identifier: MIT
// Prototype flow coverage with the production DOM/controller; no native audio or network peers.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/playwright/listen-flow');
const source = file => fs.readFileSync(path.join(ui, file), 'utf8');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), file = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      if (url.origin !== 'http://room-flow.test' || file.includes('..') || !/^(?:[\w./-]+\.css|index\.html)$/.test(file)) return route.abort();
      let body = source(file); if (file === 'index.html') body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body });
    });
    await page.goto('http://room-flow.test/');
    for (const file of ['host.js', 'themes.js', 'theme-picker.js', 'room-workspace.js', 'room-view.js', 'room.js']) await page.addScriptTag({ content: source(file) });
    await page.evaluate(async () => {
      Theme.init(); document.body.classList.add('room-view');
      document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-room'; });
      window.__snapshot = { mode: 'local' }; window.__calls = []; window.__discoverMode = 'success';
      window.__rooms = [{ room_id: 'near', name: '晚风电台', room_code: 'A1B2C3D4', addresses: ['192.0.2.1:7634'], fingerprint: 'ab'.repeat(32) }];
      window.__applicationState = 'pending';
      window.__host = () => ({ mode: 'host', room_id: 'own', instance_id: 'instance', session_id: 'session', member_id: 'host', name: '我的音乐房间', revision: '1', sharing_revision: '1', queue_count: 0, queue: [], member_capacity: 8, elapsed_ms: 42000, permissions: { queue: true, transport: true, chat_read: true, chat_send: true }, members: [{ id: 'host', name: '晚风', owner: true, connected: true, permissions: {} }], output: {}, invitations: [], admission: { room_code: 'Q1W2E3R4', pending: [] } });
      const transport = {
        get: async url => url === '/v1/room' ? structuredClone(window.__snapshot) : { tracks: [] },
        post: async (url, body) => {
          window.__calls.push(body); const request = body.request || body;
          if (body.action === 'discover') {
            if (window.__discoverMode === 'hold') await new Promise(resolve => { window.__discoverResolve = resolve; });
            if (window.__discoverMode === 'fail') throw Object.assign(new Error('网络超时'), { status: 504 });
            return { interfaces: [{ name: 'Wi-Fi', address: '192.0.2.10' }], rooms: window.__rooms, discovery_available: window.__discoverMode !== 'unavailable' };
          }
          if (body.action === 'create') { window.__snapshot = window.__host(); return { state: 'applied' }; }
          if (body.action === 'apply') return { application_id: 'application', applicant_secret: 'private-proof', expires_in_seconds: 300 };
          if (body.action === 'admission_status') return { state: window.__applicationState };
          if (body.action === 'invite') { const id = 'invite-' + window.__calls.length; window.__snapshot.invitations.push({ id, expires_in_seconds: 300 }); return { invitation: 'hertz-listen:v1:fixture', invitation_id: id, expires_in_seconds: 300 }; }
          if (body.action === 'revoke_invitation') { window.__snapshot.invitations = window.__snapshot.invitations.filter(invite => invite.id !== body.invitation_id); return {}; }
          if (body.action === 'leave') { window.__snapshot = { mode: 'local' }; return window.__snapshot; }
          if (body.action === 'join' && window.__joinError) throw Object.assign(new Error(window.__joinError), { code: window.__joinError, status: 403 });
          if (request.action === 'library') return { revision: window.__snapshot.sharing_revision, tracks: [], total: 0 };
          if (request.action === 'queue_page') return { revision: window.__snapshot.revision, queue: [], tracks: [] };
          if (request.action === 'chat_history') return { messages: [], history_revision: '1' };
          return { tracks: [], ids: [] };
        }
      };
      window.HertzClipboard = { write: async () => { if (window.__clipboardFail) throw new Error('clipboard unavailable'); } };
      window.HertzRoomTransport = { create: () => ({ render() {}, notice() {}, destroy() {}, setWorkspaceVisible() {} }) };
      HertzRoom.init({ root: document.querySelector('#view-room'), transport, confirm: async () => true }); await HertzRoom.onViewEnter();
    });
    const shot = async name => { await page.evaluate(() => document.fonts.ready); return page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); };
    const navigate = name => page.evaluate(name => HertzRoom.navigate(name), name);
    const root = page.locator('#view-room');
    await page.getByText('和身边的人，听同一首歌', { exact: true }).waitFor();
    assert.equal(await page.locator('.room-nearby-grid').isVisible(), false, 'discovery is a second level');
    await shot('entry-desktop');
    await page.getByRole('button', { name: '看看附近的房间', exact: true }).click();
    await page.locator('.room-nearby-card').waitFor();
    const refresh = page.getByRole('button', { name: '刷新房间列表', exact: true });
    await page.evaluate(() => { window.__discoverMode = 'hold'; }); await refresh.click();
    await page.locator('.room-discovery-skeleton').first().waitFor(); assert.ok(await refresh.isDisabled());
    await shot('discover-loading');
    await page.evaluate(() => { window.__discoverMode = 'success'; window.__rooms = [{ ...window.__rooms[0], name: '午后轻音乐' }]; window.__discoverResolve(); });
    await page.locator('.room-nearby-card').filter({ hasText: '午后轻音乐' }).waitFor();
    assert.equal(await page.locator('.room-nearby-card').filter({ hasText: '晚风电台' }).count(), 0, 'successful discovery replaces all old rows');
    await page.evaluate(() => { window.__discoverMode = 'fail'; }); await refresh.click();
    await page.locator('.room-discovery-error').waitFor(); assert.equal(await page.locator('.room-nearby-card').count(), 1, 'failed discovery keeps old list');
    await shot('discover-error');
    await page.evaluate(() => { window.__discoverMode = 'unavailable'; }); await refresh.click();
    await page.locator('.room-discovery-error').filter({ hasText: '发现服务暂不可用' }).waitFor();
    await page.evaluate(() => { window.__discoverMode = 'success'; }); await refresh.click();
    await page.locator('.room-nearby-card').getByRole('button', { name: '申请加入', exact: true }).click();
    const apply = page.getByRole('dialog', { name: '申请加入房间', exact: true });
    await apply.getByLabel('你的昵称', { exact: true }).fill('听众');
    await apply.getByRole('button', { name: '提交申请', exact: true }).click();
    await apply.getByRole('button', { name: '已核对，继续', exact: true }).click();
    await page.locator('.room-application[data-state=pending]').waitFor();
    await navigate('lobby'); await navigate('discover');
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.action === 'apply').length), 1, 'navigation never resubmits an application');
    await navigate('application'); await shot('application-pending');
    await page.evaluate(() => { window.__applicationState = 'rejected'; });
    await page.getByRole('button', { name: '查看申请结果', exact: true }).click(); await page.locator('.room-application[data-state=rejected]').waitFor();
    await navigate('discover');
    await page.evaluate(() => { window.__rooms = []; }); await refresh.click();
    await page.getByRole('heading', { name: '没有发现任何房间', exact: true }).waitFor(); await shot('discover-empty');
    await navigate('lobby'); await page.getByRole('button', { name: '+ 创建房间', exact: true }).click();
    const create = page.getByRole('dialog', { name: '创建房间', exact: true });
    await create.getByLabel('你的昵称', { exact: true }).fill('晚风');
    const avatarLabels = ['咖啡', '鸡尾酒', '纸杯蛋糕', '吃豆人', '棋马', '太空怪兽', '邮票', '甲虫', '雷达', '小熊', '幽灵', '外星人', '火箭', '烧瓶'];
    assert.deepEqual(await create.locator('.room-avatar-option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), avatarLabels.map(label => '头像 ' + label));
    for (const label of avatarLabels) {
      const option = create.getByRole('button', { name: '头像 ' + label, exact: true }); await option.click();
      assert.equal(await create.locator('.room-avatar-option[aria-pressed=true]').count(), 1);
      assert.ok(await create.locator('.room-avatar-preview svg path').getAttribute('d'), 'preset renders its own vector artwork');
    }
    await create.getByRole('button', { name: '头像 幽灵', exact: true }).click();
    for (const width of [360, 390, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await create.evaluate(node => node.scrollWidth <= node.clientWidth), 'avatar grid fits dialog at ' + width);
    }
    await create.getByText('封面与高级设置', { exact: true }).click();
    const photo = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
      const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(1600, 900); let seed = 42;
      for (let y = 0; y < 900; y++) for (let x = 0; x < 1600; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const i = (y * 1600 + x) * 4, grain = ((seed >>> 24) - 128) * 0.6;
        pixels.data[i] = 40 + x / 12 + grain; pixels.data[i + 1] = 60 + y / 8 + grain; pixels.data[i + 2] = 130 + 35 * Math.sin(x / 23) + grain; pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0); ctx.fillStyle = '#fff'; ctx.font = 'bold 90px sans-serif'; ctx.fillText('NIGHT RADIO', 80, 700);
      return canvas.toDataURL('image/png');
    });
    await create.getByLabel('房间封面（可选）', { exact: true }).setInputFiles({ name: 'detailed-photo.png', mimeType: 'image/png', buffer: Buffer.from(photo.split(',')[1], 'base64') });
    const coverPreview = create.locator('.room-cover-editor img'); await coverPreview.waitFor();
    await coverPreview.evaluate(node => node.decode());
    const preparedCover = await coverPreview.getAttribute('src');
    assert.ok(preparedCover.startsWith('data:image/jpeg;base64,'), 'detailed photos use JPEG instead of shrinking PNG to a tiny bitmap');
    assert.ok(Buffer.from(preparedCover.split(',')[1], 'base64').length <= 24 * 1024);
    assert.equal(await coverPreview.evaluate(node => node.naturalWidth), 512, 'cover keeps enough pixels for high-density cards');
    fs.writeFileSync(path.join(output, 'prepared-cover.jpg'), Buffer.from(preparedCover.split(',')[1], 'base64'));
    await shot('create-avatar');
    await create.getByRole('button', { name: '创建房间', exact: true }).click();
    await page.getByRole('heading', { name: '等朋友们进来', exact: true }).waitFor(); await shot('waiting');
    assert.ok(await page.locator('.room-seat [data-avatar=ghost]').count());
    assert.equal(await page.evaluate(() => localStorage.getItem('hertz.room.avatar.v1')), 'ghost');
    assert.equal(await page.evaluate(() => window.__calls.find(call => call.action === 'create').cover), preparedCover, 'creation submits the prepared cover');
    await page.getByRole('button', { name: '邀请朋友', exact: true }).click();
    const invite = page.getByRole('dialog', { name: '邀请一起听', exact: true });
    await page.evaluate(() => { window.__clipboardFail = true; }); await invite.getByRole('button', { name: '生成并复制邀请', exact: true }).click();
    await invite.getByText('邀请已生成，剪贴板暂不可用。可再次复制或展开邀请内容手动复制。', { exact: true }).waitFor();
    const issued = await page.evaluate(() => window.__calls.filter(call => call.action === 'invite').length);
    await invite.getByRole('button', { name: '再次复制邀请', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.action === 'invite').length), issued, 'copy retry reuses the same invitation');
    await invite.locator('.room-invitation-responses').getByText('待回应', { exact: true }).waitFor(); await shot('invite-pending');
    await invite.locator('.room-invitation-responses').getByRole('button', { name: '撤销邀请', exact: true }).click();
    await invite.locator('.room-invitation-responses').getByText('已撤销', { exact: true }).waitFor();
    await invite.getByRole('button', { name: '生成并复制邀请', exact: true }).click();
    assert.equal(await invite.getByRole('button', { name: '撤销这份邀请', exact: true }).isDisabled(), false);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { window.__snapshot = { ...window.__snapshot, mode: 'reconnecting', current_track: { resource_id: 'song', title: '一生中最爱', artist: '谭咏麟', duration_ms: 250000 }, track_instance_id: '1', playing: true, queue_count: 1 }; await HertzRoom.onViewEnter(); });
    await page.locator('.room-connection-banner').waitFor(); assert.ok(await page.getByRole('button', { name: '暂停', exact: true }).isDisabled());
    await navigate('invite'); assert.ok(await invite.getByRole('button', { name: '撤销这份邀请', exact: true, includeHidden: true }).isDisabled()); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.room-current').textContent(), '一生中最爱', 'reconnect retains song context'); await shot('reconnect');
    await page.evaluate(async () => { window.__snapshot.mode = 'host'; await HertzRoom.onViewEnter(); });
    assert.equal(await page.locator('.room-connection-banner').isVisible(), false);
    await navigate('invite'); assert.equal(await invite.getByRole('button', { name: '撤销这份邀请', exact: true }).isDisabled(), false, 'recovery restores valid invitation actions'); await page.keyboard.press('Escape');
    await page.locator('.room-more > summary').click(); await page.locator('.room-header-leave').click();
    const leave = page.locator('[aria-labelledby="room-entry-title-leave"]'); await leave.waitFor(); await shot('end-confirm');
    assert.ok(await leave.getByLabel('结束后给我一份收听小结', { exact: true }).isChecked());
    await leave.getByRole('button', { name: '继续一起听', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.action === 'leave').length), 0);
    await page.locator('.room-more > summary').click(); await page.locator('.room-header-leave').click(); await leave.getByRole('button', { name: '结束房间', exact: true }).click();
    await page.locator('#view-room[data-room-page=summary]').waitFor(); assert.match(await page.locator('.room-summary-track').textContent(), /一生中最爱/); await shot('summary');
    const downloadWait = page.waitForEvent('download'); await page.getByRole('button', { name: '保存收听小结', exact: true }).click();
    const download = await downloadWait; assert.equal(download.suggestedFilename(), 'Hertz-收听小结.json');
    await download.saveAs(path.join(output, 'summary.json')); const report = fs.readFileSync(path.join(output, 'summary.json'), 'utf8');
    assert.ok(!/private-proof|hertz-listen|fingerprint|credential/.test(report), 'summary never exports connection secrets');
    for (const width of [1440, 1024, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      for (const name of ['summary', 'lobby', 'discover']) {
        await navigate(name); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' fits ' + width);
      }
      if (width === 390) { await navigate('lobby'); await shot('entry-phone'); }
    }
    await page.getByRole('button', { name: '使用邀请加入', exact: true }).click();
    const join = page.getByRole('dialog', { name: '通过邀请加入', exact: true });
    await join.getByRole('button', { name: '设置头像（可选）', exact: true }).click();
    const avatar = page.getByRole('dialog', { name: '给自己一个头像', exact: true });
    await avatar.getByRole('button', { name: '使用昵称首字', exact: true }).click(); await avatar.getByRole('button', { name: '保存并继续', exact: true }).click();
    assert.ok(await join.isVisible());
    const token = 'hertz-listen:v1:' + Buffer.from(JSON.stringify({ address: '192.0.2.1:7634', fingerprint: 'ab'.repeat(32) })).toString('base64url');
    await join.getByLabel('邀请或 8 位查找码', { exact: true }).fill(token);
    await page.evaluate(() => { window.__joinError = 'room_invitation_expired'; });
    await join.getByRole('button', { name: '加入房间', exact: true }).click(); await join.getByRole('button', { name: '已核对，继续', exact: true }).click();
    await join.getByRole('heading', { name: '这份邀请已经不能用了', exact: true }).waitFor(); await shot('invitation-invalid-phone');
    await join.getByRole('button', { name: '粘贴新的邀请', exact: true }).click();
    await page.evaluate(() => { window.__joinError = 'room_capacity'; }); await join.getByRole('button', { name: '加入房间', exact: true }).click(); await join.getByRole('button', { name: '已核对，继续', exact: true }).click();
    await join.getByRole('heading', { name: '房间人数已满', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.activeElement.closest('.room-page-lobby,.room-page-discover')), 'closing modal restores focus to its opener');
    await page.evaluate(async () => { window.__snapshot = { ...window.__host(), mode: 'guest' }; await HertzRoom.onViewEnter(); window.__snapshot = { mode: 'local', last_error: 'room ended: room_ended' }; await HertzRoom.onViewEnter(); });
    await page.getByRole('heading', { name: '房间已经结束了', exact: true }).waitFor();
    await page.evaluate(async () => { window.__snapshot = { ...window.__host(), mode: 'guest', instance_id: 'new-instance' }; await HertzRoom.onViewEnter(); window.__snapshot = { mode: 'local', last_error: 'room authorization expired; a new invitation is required' }; await HertzRoom.onViewEnter(); });
    await page.getByRole('heading', { name: '你已不在这个房间', exact: true }).waitFor();
    await page.evaluate(async () => { window.__snapshot = { ...window.__host(), instance_id: 'without-summary' }; await HertzRoom.onViewEnter(); });
    await page.locator('.room-more > summary').click(); await page.locator('.room-header-leave').click();
    await leave.getByLabel('结束后给我一份收听小结', { exact: true }).uncheck();
    await leave.getByRole('button', { name: '结束房间', exact: true }).click();
    await page.locator('#view-room[data-room-page=lobby]').waitFor();
    assert.ok(await page.locator('.room-recent .room-history-row').count(), 'opting out of the summary still retains recent room history');
    assert.deepEqual(errors, []);
    await page.evaluate(() => HertzRoom.destroy());
    console.log('Room flow: entry/discovery/loading/error/empty, optional avatars, application state, waiting, invitations, reconnect, confirmed exit/summary, export, focus and 360–1440px passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
