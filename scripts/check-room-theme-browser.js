// SPDX-License-Identifier: MIT
// Real DOM/CSS with the production Theme and room views; no service or audio device.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
function source(file) {
  return fs.readFileSync(path.join(ui, file), 'utf8');
}
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://room-theme.test') return route.abort();
      const file = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      if (file.includes('..') || !/^(?:[\w./-]+\.css|index\.html)$/.test(file)) return route.abort();
      let body = source(file);
      if (file === 'index.html') body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body });
    });
    await page.goto('http://room-theme.test/');
    for (const file of ['themes.js', 'theme-picker.js', 'favorites.js', 'room-workspace.js', 'room-view.js', 'room.js']) await page.addScriptTag({ content: source(file) });
    await page.evaluate(async () => {
      Theme.init();
      ThemePicker.bind(document.querySelector('#theme-btn'));
      document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-favorites'; });
      window.__appends = 0;
      window.HertzRoom = { activateFavorite: async () => { window.__appends++; } };
      window.VMusicTransport = {
        get: async () => ({ favorites: [{ kind: 'track', source: 'lan', ref_id: 'host:stable', title: '局域网收藏歌曲', artist: '共享艺术家', album: '共享专辑', duration_ms: 32000 }], total: 1 }),
        post: async () => ({ favorited: true })
      };
      Favorites.bind({ ui: { favList: document.querySelector('#fav-list') }, state: { view: 'favorites' }, fmt: () => '0:32', toast() {}, errText: (prefix, error) => prefix + error.message, paintArt() {} });
      await Favorites.load();
    });
    const measureFavorite = () => page.evaluate(() => {
      const badge = document.querySelector('.fav-row .src-badge'), action = document.querySelector('.fav-room-append');
      const row = document.querySelector('.fav-row'), b = badge.getBoundingClientRect(), a = action.getBoundingClientRect(), r = row.getBoundingClientRect();
      return { badgeWidth: b.width, badgeHeight: b.height, badgeOverflow: badge.scrollHeight > badge.clientHeight, actionVisible: getComputedStyle(action).display !== 'none' && +getComputedStyle(action.parentElement).opacity === 1, actionWidth: a.width, actionHeight: a.height, contained: a.left >= r.left && a.right <= r.right && a.top >= r.top && a.bottom <= r.bottom, noOverflow: document.documentElement.scrollWidth <= innerWidth };
    });
    for (const skin of ['classic', 'heijiao', 'liunian', 'orbit', 'qingfeng']) {
      await page.evaluate(skin => {
        document.documentElement.dataset.skin = skin;
        document.querySelectorAll('link[data-skin-css]').forEach(link => { link.disabled = link.dataset.skinCss !== skin; });
      }, skin);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('link[data-skin-css]')).filter(link => !link.disabled).every(link => !!link.sheet));
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(100);
      // Viewport/skin transitions can still be settling on a busy build host.
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, null, { timeout: 2000 }).catch(() => {});
        const m = await measureFavorite();
        console.log('favorite', skin, width, JSON.stringify(m));
        assert.ok(!m.badgeOverflow && m.badgeWidth > 30, skin + ' LAN source remains horizontal');
        assert.ok(m.actionVisible && m.actionWidth >= 43.5 && m.actionHeight >= 43.5 && m.contained && m.noOverflow, skin + ' explicit append remains usable at ' + width);
      }
    }
    await page.getByRole('button', { name: '加入当前房间队列', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__appends), 1, 'keyboard activates the explicit append action');
    // Restore the real controller after the isolated favorites fixture.
    await page.addScriptTag({ content: source('room.js') });
    await page.evaluate(async () => {
      document.body.classList.add('room-view');
      document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-room'; });
      window.__snapshot = { mode: 'host', room_id: 'room', instance_id: 'host', session_id: 'session', member_id: 'member', name: '同一主题房间', revision: '1', sharing_revision: '1', library_search: true, track_instance_id: '1', current_track: { resource_id: 'song', title: '午夜霓虹', artist: '共享艺术家', duration_ms: 32000 }, queue: [], members: [], permissions: { queue: true, transport: true, chat_read: true, chat_send: true }, output: {} };
      window.__queue = Array.from({ length: 14 }, (_, index) => ({ instance_id: String(index + 1), resource_id: 'song-' + index }));
      window.__tracks = window.__queue.map((entry, index) => ({ resource_id: entry.resource_id, title: index === 1 ? '这是一首名字很长很长需要在共同队列中保持清晰的夜航歌曲' : '夜航选曲 ' + (index + 1), artist: '共享艺术家', duration_ms: 32000 }));
      window.__library = window.__tracks.concat(
        Array.from({ length: 30 }, (_, index) => ({ resource_id: 'other-' + index, title: '其他共享歌曲 ' + index })),
        Array.from({ length: 40 }, (_, index) => ({ resource_id: 'search-' + index, title: '全库目标 ' + String(index + 1).padStart(2, '0'), artist: '搜索艺术家' }))
      );
      window.__snapshot.queue_count = window.__queue.length;
      window.__roomRequests = []; window.__confirmRoom = async () => true;
      window.__confirmMessages = [];
      const artwork = document.createElement('canvas'); artwork.width = 640; artwork.height = 360;
      const ink = artwork.getContext('2d'); ink.fillStyle = '#243a40'; ink.fillRect(0, 0, 640, 360);
      ink.fillStyle = '#aec6ae'; ink.beginPath(); ink.arc(510, 120, 155, 0, Math.PI * 2); ink.fill();
      ink.fillStyle = '#edf0e5'; ink.font = '500 48px sans-serif'; ink.fillText('夜航电台', 48, 246);
      ink.font = '20px sans-serif'; ink.fillText('和你一起听', 50, 294); window.__coverSample = artwork.toDataURL('image/png');
      window.__hostSnapshot = structuredClone(window.__snapshot);
      window.__messages = []; window.__copied = []; window.HertzClipboard = { write: async value => { if (window.__copyFailure) throw new Error('剪贴板不可用'); window.__copied.push(value); } };
      const transport = { get: async url => url === '/v1/room' ? window.__snapshot : { tracks: [] }, post: async (url, body) => {
        window.__roomRequests.push(body);
        if (body.request && body.request.action === 'queue_page') return { revision: window.__snapshot.revision, queue: window.__queue.slice(body.request.offset, body.request.offset + body.request.limit), tracks: window.__tracks };
        if (body.request && body.request.action === 'queue') {
          if (body.request.expected_revision !== window.__snapshot.revision) throw Object.assign(new Error('队列已更新'), { code: 'revision_conflict', status: 409 });
          window.__queue = body.request.items.map((entry, index) => ({ ...entry, instance_id: entry.instance_id || 'allocated-' + index }));
          window.__snapshot = { ...window.__snapshot, revision: String(Number(window.__snapshot.revision) + 1), queue_count: window.__queue.length };
          return { state: 'applied' };
        }
        if (body.request && body.request.action === 'library') {
          const request = body.request, matches = window.__library.filter(track => !request.query || [track.title, track.artist, track.album].join(' ').includes(request.query));
          return { revision: window.__snapshot.sharing_revision, total: matches.length, tracks: matches.slice(request.offset, request.offset + request.limit) };
        }
        if (body.action === 'invite') return { invitation: 'hertz-listen:v1:fixture-' + window.__roomRequests.filter(request => request.action === 'invite').length, invitation_id: 'invite-' + window.__roomRequests.filter(request => request.action === 'invite').length, expires_in_seconds: 300 };
        if (body.action === 'apply') return { application_id: 'application-browser', applicant_secret: 'private-browser-applicant', state: 'pending', expires_in_seconds: 300 };
        if (body.request && body.request.action === 'chat_history') return { history_revision: '1', messages: window.__messages };
        if (body.request && body.request.action === 'room_profile') return { room_id: window.__snapshot.room_id, revision: window.__snapshot.room_cover_revision, cover: window.__coverSample };
        if (body.request && body.request.action === 'chat_send') {
          window.__messages.push({ message_id: String(window.__messages.length + 1), name: '夜航听众', text: body.request.text, received_at_ms: String(Date.now()) }); return { status: 'applied' };
        }
        if (body.request && body.request.action === 'resource' && body.request.kind === 'lyrics') {
          const text = JSON.stringify({ lines: [{ start_ms: 0, text: '让音乐留在此刻' }, { start_ms: 16000, text: '和你一起听下一首' }] });
          const bytes = new TextEncoder().encode(text); return { total: bytes.length, offset: 0, revision: '1', mime: 'application/json', base64: btoa(String.fromCharCode(...bytes)) };
        }
        if (body.action === 'discover') return { interfaces: [{ name: '测试网卡', address: '192.0.2.10' }], rooms: window.__discoveredRooms || [{ name: '测试房间' }] };
        if (body.action === 'room_cover') {
          if (window.__coverFailure) throw new Error('封面保存失败');
          window.__snapshot.room_cover = body.cover; return { state: 'applied' };
        }
        if (body.action === 'leave') {
          if (window.__leaveFailure) throw new Error('退出失败，请检查连接');
          if (window.__holdLeave) return new Promise(resolve => { window.__resolveLeave = (replace = true) => { const value = { mode: 'local' }; if (replace) window.__snapshot = value; resolve(value); }; });
          window.__snapshot = { mode: 'local' }; return window.__snapshot;
        }
        return { tracks: [], queue: [], messages: [], ids: [] };
      } };
      window.HertzRoomTransport = { create: () => ({ render() {}, notice() {}, destroy() {}, setWorkspaceVisible() {} }) };
      HertzRoom.init({ root: document.querySelector('#view-room'), transport, confirm: message => { window.__confirmMessages.push(message); return window.__confirmRoom(message); } });
      await HertzRoom.onViewEnter();
    });
    const theme = page.locator('#view-room').getByRole('button', { name: '切换主题色', exact: true });
    const menu = page.getByRole('listbox', { name: '主题色列表', exact: true });
    const choose = async id => {
      await theme.click();
      await menu.locator('[data-theme-id="' + id + '"]').click();
      assert.equal(await theme.getAttribute('aria-expanded'), 'false');
    };
    await page.evaluate(async () => {
      window.__snapshot = { ...window.__snapshot, admission: { room_code: 'B971D247', pending: [] }, members: [{ id: 'member', name: '夜航听众', owner: true, connected: true }] };
      await HertzRoom.onViewEnter(); HertzRoom.navigate('invite');
    });
    await page.getByRole('button', { name: '复制房间码', exact: true }).click();
    await page.waitForFunction(() => window.__copied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__copied), ['B971D247'], 'copies only the room code');
    await page.evaluate(() => { window.__copyFailure = true; });
    await page.getByRole('button', { name: '复制房间码', exact: true }).click();
    await page.getByRole('dialog', { name: '邀请一起听', exact: true }).locator('.room-notice.room-error').filter({ hasText: '剪贴板不可用' }).waitFor();
    await page.evaluate(() => { window.__copyFailure = false; });
    const inviteDrawer = page.getByRole('dialog', { name: '邀请一起听', exact: true });
    assert.ok(await inviteDrawer.isVisible(), 'invitation opens in a native drawer');
    assert.equal(await page.locator('#view-room').getAttribute('data-room-page'), 'play', 'invitation keeps the listening scene mounted');
    await inviteDrawer.getByRole('button', { name: '生成并复制邀请', exact: true }).click();
    await page.waitForFunction(() => window.__copied.length === 2);
    await inviteDrawer.getByRole('button', { name: '再次复制邀请', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'invite').length), 1, 'copying a valid invitation reuses its one-person capability');
    const invitationCopies = await page.evaluate(() => window.__copied.slice(-2));
    assert.ok(invitationCopies.every(value => value.includes('hertz-listen:v1:fixture-1')), 'copied invitation contains the original capability');
    assert.equal(invitationCopies[0], invitationCopies[1], 'copying again preserves the invitation text');
    await inviteDrawer.getByLabel('参与方式', { exact: true }).selectOption('listen');
    await inviteDrawer.getByRole('button', { name: '撤销旧邀请并生成新邀请', exact: true }).click();
    await page.waitForFunction(() => window.__roomRequests.filter(request => request.action === 'invite').length === 2);
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'revoke_invitation').at(-1).invitation_id), 'invite-1', 'changing permissions revokes the prior capability');
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'invite').at(-1).permissions.queue), false, 'listening preset does not grant queue access');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '＋ 点歌', exact: true }).click();
    const songPicker = page.getByRole('dialog', { name: '添加歌曲', exact: true });
    assert.ok(await songPicker.isVisible(), 'song picker opens in a native drawer');
    await songPicker.getByLabel('搜索已共享歌曲', { exact: true }).fill('夜航');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '＋ 点歌', exact: true }).click();
    assert.equal(await songPicker.getByLabel('搜索已共享歌曲', { exact: true }).inputValue(), '夜航', 'closing preserves the picker search draft');
    const sharedSearch = songPicker.getByLabel('搜索已共享歌曲', { exact: true });
    assert.equal(await songPicker.locator('.room-list').getByText('全库目标 01', { exact: true }).count(), 0, 'target starts beyond the initial shared page');
    await sharedSearch.fill('全库目标');
    await sharedSearch.press('Enter');
    await songPicker.locator('.room-list').getByText('全库目标 01', { exact: true }).waitFor();
    assert.equal(await songPicker.locator('.room-list > .room-track').count(), 32, 'search returns the first matching server page');
    assert.deepEqual(await page.evaluate(() => { const request = window.__roomRequests.filter(body => body.request && body.request.action === 'library').at(-1).request; return { query: request.query, offset: request.offset, limit: request.limit }; }), { query: '全库目标', offset: 0, limit: 32 }, 'search forwards the query across the authorized shared library');
    const libraryNext = songPicker.getByRole('button', { name: '下一页', exact: true }), libraryPrevious = songPicker.getByRole('button', { name: '上一页', exact: true });
    assert.ok(await libraryPrevious.isDisabled(), 'first result page disables previous');
    await libraryNext.click();
    await songPicker.locator('.room-list').getByText('全库目标 33', { exact: true }).waitFor();
    assert.equal(await songPicker.locator('.room-list > .room-track').count(), 8, 'next page contains the remaining matches');
    assert.ok(await libraryNext.isDisabled(), 'last result page disables next');
    assert.deepEqual(await page.evaluate(() => { const request = window.__roomRequests.filter(body => body.request && body.request.action === 'library').at(-1).request; return { query: request.query, offset: request.offset, limit: request.limit }; }), { query: '全库目标', offset: 32, limit: 32 }, 'pagination retains the query');
    await sharedSearch.fill('不存在的共享歌曲'); await songPicker.getByRole('button', { name: '搜索歌曲', exact: true }).click();
    await songPicker.getByText('没有匹配的共享歌曲，试试其他关键词。', { exact: true }).waitFor();
    assert.equal(await libraryNext.isVisible(), false, 'empty search hides pagination');
    await sharedSearch.fill(''); await sharedSearch.press('Enter');
    await songPicker.locator('.room-list').getByText('夜航选曲 1', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const composer = page.getByLabel('说点什么（最多 200 字）', { exact: true });
    await composer.fill('舞台与聊天共用草稿');
    await page.evaluate(() => { window.__composer = document.querySelector('.room-chat-form textarea'); HertzRoom.navigate('collaborate'); });
    await page.getByRole('tab', { name: '聊天', exact: true }).click();
    assert.equal(await composer.inputValue(), '舞台与聊天共用草稿');
    await page.evaluate(() => HertzRoom.navigate('play'));
    assert.ok(await composer.evaluate(node => node === window.__composer), 'stage and chat reuse the same input');
    await page.getByRole('tab', { name: '队列', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    const movingRow = page.locator('.room-queue > li[data-instance="4"]');
    await movingRow.locator('summary').click();
    for (const [label, expectedIndex] of [['上移', 2], ['下移', 3]]) {
      const revision = await page.evaluate(() => window.__snapshot.revision);
      await movingRow.getByRole('button', { name: label, exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(({ revision, label }) => window.__snapshot.revision !== revision && document.querySelector('.room-queue > li[data-instance="4"] button:focus')?.textContent === label, { revision, label });
      assert.equal(await page.evaluate(() => window.__queue.findIndex(entry => entry.instance_id === '4')), expectedIndex, label + ' persists the moved queue instance');
      assert.equal(await movingRow.getByRole('button', { name: label, exact: true }).evaluate(node => node === document.activeElement), true, label + ' restores keyboard focus after snapshot redraw');
      assert.equal(await movingRow.locator('details').evaluate(node => node.open), true, 'queue menu stays open after ' + label);
    }
    await movingRow.locator('summary').click();
    for (const [width, height] of [[1280, 720], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const output = path.resolve(__dirname, '../output/ui-productization'); fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'room-scene-' + width + '.png') });
      if (width >= 1000) {
        const queuePanel = page.locator('#room-stage-panel-queue');
        const scroll = await queuePanel.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
        assert.ok(scroll.content > scroll.height && scroll.height < height && scroll.overflow === 'auto', 'long queues use a bounded scroll area at ' + width);
        await queuePanel.evaluate(node => { node.scrollTop = node.scrollHeight; });
        const panelBox = await queuePanel.boundingBox(), lastSong = await queuePanel.locator('.room-queue > li').last().boundingBox();
        assert.ok(lastSong.y + lastSong.height <= panelBox.y + panelBox.height + 1, 'last queued song is reachable at ' + width);
        await queuePanel.evaluate(node => { node.scrollTop = 0; });
      }
    }
    // Native browser 200% zoom has a 720x450 CSS viewport on a 1440x900 window.
    await page.setViewportSize({ width: 720, height: 450 });
    await page.getByRole('button', { name: '＋ 点歌', exact: true }).focus(); await page.keyboard.press('Enter');
    const reflowDrawer = await songPicker.boundingBox();
    assert.ok(reflowDrawer.x >= 0 && reflowDrawer.x + reflowDrawer.width <= 721 && reflowDrawer.height <= 451, 'drawer fits the effective viewport of native 200 percent zoom: ' + JSON.stringify(reflowDrawer));
    assert.equal(await sharedSearch.evaluate(node => node === document.activeElement), true, 'reflowed drawer focuses search');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; document.querySelector('#view-room').scrollTop = 0; });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).zoom === '2');
    const zoomGeometry = await page.evaluate(() => {
      const root = document.querySelector('#view-room'), play = document.querySelector('.room-play-button').getBoundingClientRect();
      return { zoom: getComputedStyle(document.documentElement).zoom, overflow: document.documentElement.scrollWidth > innerWidth, roomWidth: root.getBoundingClientRect().width, playWidth: play.width, playRight: play.right };
    });
    assert.equal(zoomGeometry.zoom, '2', '200 percent zoom is applied');
    assert.ok(!zoomGeometry.overflow && zoomGeometry.roomWidth <= 1440 && zoomGeometry.playWidth >= 80 && zoomGeometry.playRight <= 1440, 'listening controls fit at 200 percent zoom: ' + JSON.stringify(zoomGeometry));
    const zoomTrigger = page.getByRole('button', { name: '＋ 点歌', exact: true });
    await zoomTrigger.focus(); await page.keyboard.press('Enter');
    assert.ok(await songPicker.isVisible(), 'keyboard opens song drawer at 200 percent zoom');
    assert.equal(await sharedSearch.evaluate(node => node === document.activeElement), true, 'zoomed drawer focuses search');
    const zoomDrawer = await songPicker.boundingBox();
    const zoomOutput = path.resolve(__dirname, '../output/ui-productization'); fs.mkdirSync(zoomOutput, { recursive: true });
    await page.screenshot({ path: path.join(zoomOutput, 'room-song-drawer-200-percent.png') });
    assert.ok(zoomDrawer.x >= 0 && zoomDrawer.x + zoomDrawer.width <= 1441 && zoomDrawer.height <= 901, 'drawer stays within the zoomed viewport: ' + JSON.stringify(zoomDrawer));
    for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); assert.ok(await songPicker.evaluate(node => node.contains(document.activeElement)), 'zoomed drawer retains keyboard focus'); }
    await page.keyboard.press('Escape');
    assert.equal(await zoomTrigger.evaluate(node => node === document.activeElement), true, 'zoomed drawer restores its trigger focus');
    await page.evaluate(() => { document.documentElement.style.zoom = ''; document.querySelector('#view-room').scrollTop = 0; });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).zoom === '1');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await composer.fill('');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await page.locator('.room-danmaku span').count(), 0, 'history is not replayed on stage');
    await composer.fill('这首歌适合一起听');
    await page.getByRole('button', { name: '发送弹幕', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.room-danmaku span'));
    assert.equal(await page.locator('.room-danmaku span').count(), 1, 'confirmed own message is animated once');
    assert.equal(await composer.inputValue(), '', 'confirmed send clears draft');
    await page.evaluate(() => HertzRoom.onViewEnter());
    assert.equal(await page.locator('.room-danmaku span').count(), 1, 'polling never duplicates an animation');
    const asideTabs = page.getByRole('tablist', { name: '一起听现场' });
    await asideTabs.getByRole('tab', { name: '队列', exact: true }).click();
    assert.equal(await page.locator('.room-play-aside [role=tabpanel]:visible').count(), 1);
    await asideTabs.getByRole('tab', { name: '成员', exact: true }).click();
    await asideTabs.getByRole('tab', { name: '成员', exact: true }).focus();
    await page.keyboard.press('Home');
    assert.equal(await asideTabs.getByRole('tab', { name: '队列', exact: true }).getAttribute('aria-selected'), 'true', 'Home selects the queue');
    await page.keyboard.press('End');
    assert.equal(await asideTabs.getByRole('tab', { name: '成员', exact: true }).getAttribute('aria-selected'), 'true', 'End selects members');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await asideTabs.getByRole('tab', { name: '聊天', exact: true }).getAttribute('aria-selected'), 'true', 'arrow keys switch the scene aside');
    assert.equal(await asideTabs.getByRole('tab', { name: '聊天', exact: true }).evaluate(node => node === document.activeElement), true, 'arrow keys focus the selected aside tab');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    assert.equal(await asideTabs.getByRole('tab', { name: '队列', exact: true }).getAttribute('aria-selected'), 'true', 'Right wraps from members to queue');
    assert.equal(await page.locator('.room-chat-form textarea').count(), 1, 'scene and chat have one composer owner');
    await asideTabs.getByRole('tab', { name: '队列', exact: true }).click();
    await page.getByLabel('显示实时弹幕', { exact: true }).uncheck();
    assert.equal(await page.locator('.room-danmaku span').count(), 0, 'turning off clears animations');
    await page.getByLabel('显示实时弹幕', { exact: true }).check();
    for (const width of [1440, 1024, 700, 390, 360]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await choose('orbit-fog');
      await page.locator('#view-room').evaluate(node => { node.scrollTop = 0; });
      const layout = await page.evaluate(() => {
        const scene = document.querySelector('.room-stage-scene').getBoundingClientRect(), input = document.querySelector('.room-stage-chat-dock textarea').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, sceneWidth: scene.width, inputWidth: input.width, titleSize: parseFloat(getComputedStyle(document.querySelector('.room-current')).fontSize) };
      });
      assert.ok(!layout.overflow && layout.sceneWidth > 200 && layout.inputWidth > 100 && layout.titleSize <= 20, 'stage fits ' + width + ': ' + JSON.stringify(layout));
      const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
      if (width === 1440 || width === 390) {
        await page.evaluate(async () => { window.__messages.push({ message_id: String(window.__messages.length + 1), name: '夜航听众', text: '和你一起听这首歌', received_at_ms: String(Date.now()) }); await HertzRoom.onViewEnter(); });
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(output, 'room-stage-' + width + '.png') });
      }
    }
    await page.evaluate(async () => {
      HertzRoom.navigate('settings'); window.__messages.push({ message_id: String(window.__messages.length + 1), name: '朋友', text: '离开舞台时的消息', received_at_ms: String(Date.now()) }); await HertzRoom.onViewEnter(); HertzRoom.navigate('play');
    });
    assert.equal(await page.locator('.room-danmaku span').count(), 0, 'returning to stage never replays background messages');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await composer.fill('减少动态效果'); await page.getByRole('button', { name: '发送弹幕', exact: true }).click();
    await page.waitForFunction(() => window.__messages.some(message => message.text === '减少动态效果'));
    assert.equal(await page.locator('.room-danmaku span').count(), 0, 'reduced motion suppresses animation');
    await page.evaluate(async () => { window.__snapshot.permissions.chat_send = false; await HertzRoom.onViewEnter(); });
    assert.equal(await composer.isDisabled(), true, 'revoked send permission disables stage input');
    await page.evaluate(async () => { window.__snapshot.permissions.chat_send = true; await HertzRoom.onViewEnter(); });
    // Settings share the app's compact type scale and show one category at a time.
    for (const width of [1440, 1024, 700, 390, 360]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await choose('orbit-fog');
      await page.evaluate(() => HertzRoom.navigate('settings'));
      const tabs = page.getByRole('tablist', { name: '房间设置分类' });
      const outputTab = tabs.getByRole('tab', { name: '本机输出', exact: true });
      assert.equal(await tabs.getByRole('tab').count(), 9, 'host has all settings categories including room profile');
      for (const tab of await tabs.getByRole('tab').all()) {
        await tab.click();
        assert.equal(await page.locator('.room-settings-panel:visible').count(), 1, 'only one category is visible');
      }
      await outputTab.click();
      const volume = page.getByLabel('本机音量（0–100）', { exact: true });
      await volume.fill('63');
      await tabs.getByRole('tab', { name: '房间音效', exact: true }).click();
      await outputTab.click();
      assert.equal(await volume.inputValue(), '63', 'category changes retain unsaved input');
      await page.evaluate(() => HertzRoom.onViewEnter());
      assert.equal(await outputTab.getAttribute('aria-selected'), 'true', 'polling retains current category');
      assert.equal(await volume.inputValue(), '63', 'polling retains unsaved input');
      await outputTab.focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await tabs.getByRole('tab', { name: '房间音效', exact: true }).getAttribute('aria-selected'), 'true', 'arrow keys switch categories');
      await page.keyboard.press('End');
      assert.equal(await tabs.getByRole('tab', { name: '房间会话', exact: true }).getAttribute('aria-selected'), 'true', 'End reaches final category');
      await page.keyboard.press('Home');
      assert.equal(await tabs.getByRole('tab', { name: '成员与申请', exact: true }).getAttribute('aria-selected'), 'true', 'Home returns to members');
      await page.evaluate(() => HertzRoom.navigate('play'));
      await page.locator('.room-stage-details').evaluate(node => { node.open = true; });
      await page.getByRole('button', { name: '查看同步与输出详情', exact: true }).click();
      assert.equal(await outputTab.getAttribute('aria-selected'), 'true', 'output shortcut opens the output category');
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('.room-settings-content'), title = document.querySelector('.room-header h1');
        return { overflow: document.documentElement.scrollWidth > innerWidth, size: parseFloat(getComputedStyle(title).fontSize), bounded: pane.clientHeight < innerHeight, scroll: getComputedStyle(pane).overflowY };
      });
      assert.ok(!geometry.overflow && geometry.size <= 24 && geometry.bounded && geometry.scroll === 'auto', 'compact settings fit ' + width + ': ' + JSON.stringify(geometry));
      const pane = page.locator('.room-settings-content');
      const paneBox = await pane.boundingBox();
      await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + 40);
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(150);
      assert.ok(await pane.evaluate(node => node.scrollHeight <= node.clientHeight || node.scrollTop > 0), 'wheel scrolls the settings pane at ' + width);
      const note = page.getByText('输出使用原生服务。驱动时间戳有效不等于已完成扬声器的物理校准。', { exact: true });
      const noteBox = await note.boundingBox();
      assert.ok(noteBox.y + noteBox.height <= paneBox.y + paneBox.height + 1, 'final output explanation is reachable at ' + width);
      assert.ok(noteBox.y + noteBox.height <= (await page.locator('#view-room').boundingBox()).height + 1, 'settings explanation remains inside the room viewport at ' + width);
      await pane.evaluate(node => { node.scrollTop = 0; });
      const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, 'room-settings-tabs-' + width + '.png') });
    }
    await page.evaluate(async () => { window.__snapshot = { ...window.__snapshot, mode: 'guest', session_id: 'guest-settings' }; await HertzRoom.onViewEnter(); HertzRoom.navigate('settings'); });
    assert.equal(await page.getByRole('tablist', { name: '房间设置分类' }).getByRole('tab').count(), 4, 'guests only see available categories');
    await page.evaluate(async () => { window.__snapshot = { ...window.__snapshot, mode: 'host', session_id: 'session' }; await HertzRoom.onViewEnter(); HertzRoom.navigate('play'); });
    for (const width of [1440, 1024, 700, 390, 360]) {
      await page.setViewportSize({ width, height: width === 360 ? 800 : width < 700 ? 844 : 1000 });
      await choose('orbit-fog');
      await page.waitForTimeout(500);
      const light = await page.evaluate(() => {
        const root = document.querySelector('#view-room'), primary = root.querySelector('.primary');
        return { bg: getComputedStyle(root).backgroundColor, ink: getComputedStyle(primary).color };
      });
      assert.equal(light.bg, 'rgb(228, 230, 238)', 'room inherits light Theme background: ' + JSON.stringify(light));
      assert.equal(light.ink, 'rgb(255, 255, 255)', 'primary button uses global accent ink');
      await page.evaluate(() => Theme.apply('mineral'));
      await theme.click();
      assert.equal(await menu.locator('[aria-selected="true"]').getAttribute('data-theme-id'), 'mineral', 'global changes sync room immediately');
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0, 'shared popup stays inside viewport at ' + width);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await theme.evaluate(node => node === document.activeElement), true, 'selection restores trigger focus');
      assert.ok(await theme.isVisible());
      const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
      if (width === 1440 || width === 390) {
        await theme.click();
        await page.screenshot({ path: path.join(output, 'room-theme-button-' + width + '.png') });
        await page.keyboard.press('Escape');
        assert.equal(await theme.evaluate(node => node === document.activeElement), true, 'Escape restores trigger focus');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'room fits ' + width);
      const controls = await page.locator('.room-play-button').boundingBox();
      assert.ok(controls && controls.x >= 0 && controls.x + controls.width <= width, 'primary playback stays within the viewport at ' + width);
    }
    await page.evaluate(() => { Theme.register({ id: 'room-custom', name: '扩展自定义配色', tokens: { '--bg': '#18232a', '--accent': '#aadeef' } }); });
    await choose('room-custom');
    assert.equal(await page.evaluate(() => localStorage.getItem('vmusic.theme.v2')), 'room-custom', 'room uses existing global persistence');
    await page.evaluate(async () => { window.__snapshot = { mode: 'local' }; await HertzRoom.onViewEnter(); });
    assert.ok(await theme.isVisible(), 'unjoined lobby has a palette button');
    const joinTrigger = page.locator('.room-page-lobby > .room-toolbar').getByRole('button', { name: '使用邀请加入', exact: true });
    const joinDialog = page.getByRole('dialog', { name: '通过邀请加入', exact: true });
    const createDialog = page.getByRole('dialog', { name: '创建房间', exact: true });
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
      await page.evaluate(() => { document.querySelector('#view-room').scrollTop = 0; });
      const before = await page.locator('#view-room').evaluate(node => node.scrollTop);
      await joinTrigger.click();
      assert.ok(await joinDialog.isVisible(), 'invitation opens a dialog at ' + width);
      assert.equal(await page.locator('#view-room').evaluate(node => node.scrollTop), before, 'opening leaves lobby scroll unchanged');
      const invitation = joinDialog.getByLabel('邀请或 8 位查找码', { exact: true });
      assert.ok(await invitation.evaluate(node => node === document.activeElement), 'invitation input receives focus');
      if (width === 1440) assert.equal(await joinDialog.getByLabel('你的昵称', { exact: true }).inputValue(), '', 'first entry asks for an explicit nickname');
      await joinDialog.getByLabel('你的昵称', { exact: true }).fill('初次听众');
      await invitation.fill('保留未提交的邀请');
      for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); assert.ok(await joinDialog.evaluate(node => node.contains(document.activeElement)), 'Tab stays inside dialog'); }
      await joinDialog.getByRole('button', { name: '加入房间', exact: true }).click();
      await joinDialog.locator('.room-notice').filter({ hasText: '请粘贴有效的房主邀请' }).waitFor();
      const box = await joinDialog.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= (width === 1440 ? 900 : 800), 'entry dialog fits viewport');
      const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
      if (width !== 360) await page.screenshot({ path: path.join(output, 'room-join-dialog-' + width + '.png') });
      await page.keyboard.press('Escape');
      assert.equal(await joinDialog.count(), 0, 'Escape closes invitation');
      assert.ok(await joinTrigger.evaluate(node => node === document.activeElement), 'close restores trigger focus');
      assert.equal(await page.locator('#view-room').evaluate(node => node.scrollTop), before, 'close preserves scroll position');
      await joinTrigger.click();
      assert.equal(await invitation.inputValue(), '保留未提交的邀请', 'closing preserves invitation draft');
      await page.mouse.click(2, 2);
      assert.equal(await joinDialog.count(), 0, 'backdrop click closes dialog');
      await page.getByRole('button', { name: '+ 创建房间', exact: true }).click();
      assert.ok(await createDialog.isVisible(), 'create uses a dialog too');
      await createDialog.getByRole('button', { name: '刷新网卡', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="局域网网卡"]').value === '192.0.2.10');
      await createDialog.getByLabel('你的昵称', { exact: true }).fill('  房主夜航  ');
      if (width === 1440) {
        await createDialog.locator('.room-create-advanced summary').click();
        const bytes = Buffer.from((await page.evaluate(() => window.__coverSample)).split(',')[1], 'base64');
        await createDialog.getByLabel('房间封面（可选）', { exact: true }).setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: bytes });
        await createDialog.locator('.room-cover-editor img').waitFor();
      }
      await createDialog.getByRole('button', { name: '创建房间', exact: true }).click();
      await page.waitForFunction(() => window.__roomRequests.some(request => request.action === 'create' && request.host_name === '房主夜航'));
      assert.ok(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'create').at(-1).cover.startsWith('data:image/png;base64,')), 'creation carries the selected room cover');
      await createDialog.getByRole('button', { name: '关闭创建房间', exact: true }).click();
      assert.equal(await createDialog.count(), 0);
    }
    // Verification stays inside the entry dialog so the native modal retains focus ownership.
    await page.evaluate(() => { window.hertzHost = { isDbx: true }; });
    await page.addScriptTag({ content: source('dialogs.js') });
    await page.evaluate(() => { window.__confirmRoom = message => hertzDialog.confirm(message); });
    await page.locator('.room-nearby-card').getByRole('button', { name: '使用邀请加入', exact: true }).click();
    assert.equal(await joinDialog.getByLabel('你的昵称', { exact: true }).inputValue(), '  房主夜航  ', 'nickname follows between entry methods');
    await joinDialog.getByLabel('你的昵称', { exact: true }).fill('');
    await joinDialog.getByRole('button', { name: '加入房间', exact: true }).click();
    await joinDialog.locator('.room-notice').filter({ hasText: '请输入 1–32 个字符的昵称' }).waitFor();
    await joinDialog.getByLabel('你的昵称', { exact: true }).fill('  听众小夜  ');
    await joinDialog.getByLabel('邀请或 8 位查找码', { exact: true }).fill('hertz-listen:v1:eyJhZGRyZXNzIjoiMTkyLjAuMi4xMDoxNzAwMCIsImZpbmdlcnByaW50IjoiYWFiYiJ9');
    await joinDialog.getByRole('button', { name: '加入房间', exact: true }).click();
    const verification = joinDialog.locator('.room-verification'); await verification.waitFor();
    assert.ok(await joinDialog.isVisible(), 'fingerprint verification keeps the native dialog open');
    assert.equal(await verification.getByRole('button', { name: '已核对，继续', exact: true }).evaluate(node => node === document.activeElement), true, 'verification receives focus');
    await verification.getByRole('button', { name: '返回修改', exact: true }).click();
    assert.ok((await joinDialog.getByLabel('邀请或 8 位查找码', { exact: true }).inputValue()).startsWith('hertz-listen:'), 'cancelled verification retains invitation');
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'join').length), 0, 'cancelled verification never joins');
    await page.evaluate(() => { window.__confirmRoom = async () => true; });
    await joinDialog.getByRole('button', { name: '加入房间', exact: true }).click();
    await verification.getByRole('button', { name: '已核对，继续', exact: true }).click();
    await page.waitForFunction(() => window.__roomRequests.some(request => request.action === 'join' && request.name === '听众小夜'));
    await page.evaluate(() => HertzRoom.onViewExit());
    assert.equal(await joinDialog.count(), 0, 'leaving workspace closes entry dialog');
    assert.notEqual(await page.locator('#view-room').evaluate(node => node.style.overflow), 'hidden', 'leaving releases scroll lock');
    await page.evaluate(() => HertzRoom.onViewEnter());
    await theme.click();
    assert.equal(await menu.locator('[aria-selected="true"]').getAttribute('data-theme-id'), 'room-custom', 'lobby remount retains global theme');
    await page.keyboard.press('Tab');
    assert.equal(await menu.isVisible(), false, 'Tab closes the popup');
    await theme.click();
    await page.locator('#view-room h1').click();
    assert.equal(await menu.isVisible(), false, 'outside click closes the popup');
    // Room profile editing keeps drafts until the native service confirms the write.
    await page.evaluate(async () => { window.__snapshot = { ...window.__hostSnapshot, session_id: 'cover-host' }; await HertzRoom.onViewEnter(); HertzRoom.navigate('settings'); });
    await page.getByRole('tab', { name: '房间资料', exact: true }).click();
    const coverInput = page.getByLabel('房间封面（可选）', { exact: true });
    await coverInput.setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await page.locator('.room-notice.room-error').filter({ hasText: '请选择 8 MiB' }).waitFor();
    const sample = Buffer.from((await page.evaluate(() => window.__coverSample)).split(',')[1], 'base64');
    await coverInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: sample });
    const saveCover = page.getByRole('button', { name: '保存房间封面', exact: true });
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(node => node.textContent === '保存房间封面').disabled);
    const draftCover = await page.locator('.room-cover-editor img').getAttribute('src');
    assert.ok(Buffer.from(draftCover.split(',')[1], 'base64').length <= 24 * 1024, 'shared cover is bounded');
    assert.ok(await page.locator('.room-cover-editor img').evaluate(node => node.naturalWidth <= 320 && node.naturalHeight <= 180), 'upload resizes the image');
    await page.evaluate(() => HertzRoom.onViewEnter());
    assert.equal(await page.locator('.room-cover-editor img').getAttribute('src'), draftCover, 'polling preserves cover draft');
    await page.evaluate(() => { window.__coverFailure = true; });
    await saveCover.click(); await page.locator('.room-notice.room-error').filter({ hasText: '封面保存失败' }).waitFor();
    assert.equal(await page.evaluate(() => window.__snapshot.room_cover || null), null, 'failed save never changes confirmed cover');
    assert.equal(await page.locator('.room-cover-editor img').getAttribute('src'), draftCover, 'failed save keeps draft available');
    await page.evaluate(() => { window.__coverFailure = false; });
    await saveCover.click(); await page.waitForFunction(() => !!window.__snapshot.room_cover);
    assert.equal(await page.evaluate(() => window.__snapshot.room_cover), draftCover);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).find(node => node.textContent === '保存房间封面').disabled);
    await page.getByRole('button', { name: '移除封面', exact: true }).click();
    await saveCover.click(); await page.waitForFunction(() => window.__snapshot.room_cover === null);
    assert.equal(await page.locator('.room-cover-editor img').count(), 0, 'removing cover returns to the room name');
    // Cancelled and failed exits retain the room. Host and guest share one close flow.
    const headerLeave = page.locator('.room-header-leave');
    const clickHeaderLeave = async () => { await page.locator('.room-more').evaluate(node => { node.open = true; }); await headerLeave.click(); };
    let leaves = await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'leave').length);
    await page.evaluate(() => { window.__confirmRoom = async () => false; });
    await clickHeaderLeave();
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'leave').length), leaves, 'cancel does not end host room');
    assert.ok(await page.evaluate(() => window.__confirmMessages.at(-1).includes('所有成员将停止收听')), 'host warning states the effect on everyone');
    await page.evaluate(async () => { window.__snapshot = { ...window.__hostSnapshot, mode: 'guest', session_id: 'exit-guest', room_cover_revision: 'member-cover' }; await HertzRoom.onViewEnter(); HertzRoom.navigate('lobby'); });
    await page.locator('.room-current-card img').waitFor();
    let profileReads = await page.evaluate(() => window.__roomRequests.filter(request => request.request && request.request.action === 'room_profile').length);
    await page.evaluate(async () => { await HertzRoom.onViewEnter(); await HertzRoom.onViewEnter(); });
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.request && request.request.action === 'room_profile').length), profileReads, 'member polls reuse cover bytes');
    await page.evaluate(async () => { window.__snapshot.room_cover_revision = null; await HertzRoom.onViewEnter(); HertzRoom.navigate('settings'); });
    assert.equal(await page.locator('.room-current-card img').count(), 0, 'members observe cover removal');
    assert.equal(await page.getByRole('tab', { name: '房间资料', exact: true }).count(), 0, 'guests cannot edit room artwork');
    assert.equal(await headerLeave.textContent(), '离开房间');
    await page.evaluate(() => { window.__confirmRoom = async () => true; window.__leaveFailure = true; });
    await clickHeaderLeave(); await page.locator('.room-notice.room-error').filter({ hasText: '退出失败' }).waitFor();
    assert.equal(await page.evaluate(() => window.__snapshot.mode), 'guest', 'failed exit keeps the active room');
    assert.ok(await page.evaluate(() => window.__confirmMessages.at(-1).includes('其他成员可继续收听')), 'guest warning preserves everyone else');
    await page.evaluate(() => {
      window.__leaveFailure = false; window.__holdLeave = true;
      window.__discoveredRooms = [
        { name: '夜航电台', cover: window.__coverSample, room_code: 'A1B2C3D4', fingerprint: 'ab'.repeat(32), addresses: ['192.0.2.5:17000'], room_id: 'a' },
        { name: '午后轻音乐', room_code: 'B2C3D4E5', fingerprint: 'ab'.repeat(32), addresses: ['192.0.2.6:17000'], room_id: 'b' },
        { name: '周末一起听一间名字比较长的音乐房间', cover: 'data:image/png;base64,bm90IHBuZw==', room_id: 'c' }
      ];
    });
    leaves = await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'leave').length);
    await clickHeaderLeave(); await page.waitForFunction(() => !!window.__resolveLeave);
    await headerLeave.evaluate(node => { node.click(); node.click(); });
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'leave').length), leaves + 1, 'pending exit is submitted once');
    await page.evaluate(() => window.__resolveLeave());
    await page.waitForFunction(() => document.querySelector('#view-room').dataset.roomPage === 'lobby' && document.querySelectorAll('.room-nearby-card').length === 3);
    assert.equal(await headerLeave.isVisible(), false, 'confirmed exit returns to unjoined lobby');
    assert.equal(await page.locator('.room-nearby-card').nth(0).locator('img').count(), 1);
    assert.equal(await page.locator('.room-nearby-card').nth(1).locator('.room-card-name').textContent(), '午后轻音乐');
    await page.waitForFunction(() => !document.querySelectorAll('.room-nearby-card')[2].querySelector('img'));
    assert.equal(await page.locator('.room-nearby-card').nth(2).locator('.room-card-name').isVisible(), true, 'broken artwork falls back to room name');
    await page.locator('.room-nearby-card').nth(1).getByRole('button', { name: '申请加入', exact: true }).click();
    const applicationDialog = page.getByRole('dialog', { name: '申请加入房间', exact: true });
    await applicationDialog.getByLabel('你的昵称', { exact: true }).fill('申请者小夜');
    await applicationDialog.getByLabel('申请通过后在本机收听', { exact: true }).uncheck();
    await page.evaluate(() => { window.__confirmRoom = async () => false; });
    await applicationDialog.getByRole('button', { name: '提交申请', exact: true }).click();
    await applicationDialog.locator('.room-verification').getByRole('button', { name: '返回修改', exact: true }).click();
    assert.equal(await applicationDialog.getByLabel('你的昵称', { exact: true }).inputValue(), '申请者小夜', 'cancelled host verification retains the application nickname');
    assert.equal(await applicationDialog.getByLabel('申请通过后在本机收听', { exact: true }).isChecked(), false);
    await page.keyboard.press('Escape');
    const applyCount = await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'apply').length);
    const joinCount = await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'join').length);
    await joinTrigger.click();
    await joinDialog.getByLabel('邀请或 8 位查找码', { exact: true }).fill('b2c3d4e5');
    await joinDialog.getByRole('button', { name: '加入房间', exact: true }).click();
    await joinDialog.locator('.room-verification').waitFor();
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'apply').length), applyCount, 'lookup code waits for fingerprint verification');
    await joinDialog.getByRole('button', { name: '已核对，继续', exact: true }).click();
    await page.waitForFunction(count => window.__roomRequests.filter(request => request.action === 'apply').length === count + 1, applyCount);
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'join').length), joinCount, 'lookup code submits an application rather than bypassing approval');
    assert.equal(await page.evaluate(() => window.__roomRequests.filter(request => request.action === 'apply').at(-1).room_code), 'B2C3D4E5', 'lookup is case insensitive and targets the discovered room');
    await page.evaluate(() => { window.__confirmRoom = async () => true; });
    for (const width of [1440, 1024, 700, 390, 360]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      for (const id of ['orbit-fog', 'mineral']) {
        await choose(id);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'cover cards fit ' + width + ' in ' + id);
      }
      if (width === 1440 || width === 390) {
        const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'room-lobby-covers-' + width + '.png'), fullPage: true });
      }
    }
    const roomSearch = page.getByLabel('搜索房间名称或房间码', { exact: true });
    await roomSearch.fill('午后'); assert.equal(await page.locator('.room-nearby-card').count(), 1);
    await roomSearch.fill('没有这间房'); assert.equal(await page.locator('.room-nearby-card').count(), 0);
    await roomSearch.fill('');
    // A delayed leave response cannot tear down a replacement room.
    await page.evaluate(async () => { window.__snapshot = { ...window.__hostSnapshot, mode: 'guest', session_id: 'old-exit-session' }; window.__resolveLeave = null; await HertzRoom.onViewEnter(); });
    await clickHeaderLeave(); await page.waitForFunction(() => !!window.__resolveLeave);
    await page.evaluate(async () => { window.__snapshot = { ...window.__hostSnapshot, room_id: 'replacement-room', instance_id: 'replacement-instance', session_id: 'replacement-session' }; await HertzRoom.onViewEnter(); window.__resolveLeave(false); });
    await page.waitForFunction(() => document.querySelector('#view-room').getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => window.__snapshot.room_id), 'replacement-room');
    assert.equal(await headerLeave.textContent(), '结束一起听');
    // The settings exit is the same confirmed host operation as the header exit.
    await page.evaluate(() => { window.__holdLeave = false; HertzRoom.navigate('settings'); });
    await page.getByRole('tab', { name: '房间会话', exact: true }).click();
    await page.locator('.room-settings-panel:visible').getByRole('button', { name: '结束并退出', exact: true }).click();
    await page.waitForFunction(() => window.__snapshot.mode === 'local' && document.querySelector('#view-room').dataset.roomPage === 'lobby');
    await choose('room-custom');
    await page.evaluate(() => { document.body.classList.remove('room-view'); document.querySelector('#view-room').hidden = true; });
    const outer = page.locator('#theme-btn');
    await outer.click();
    assert.equal(await menu.locator('[aria-selected="true"]').getAttribute('data-theme-id'), 'room-custom', 'application uses the same selected theme and menu');
    await menu.locator('[data-theme-id="orbit-fog"]').click();
    assert.equal(await page.evaluate(() => Theme.current().id), 'orbit-fog');
    await page.evaluate(() => { document.body.classList.add('room-view'); document.querySelector('#view-room').hidden = false; });
    await theme.click();
    assert.equal(await menu.locator('[aria-selected="true"]').getAttribute('data-theme-id'), 'orbit-fog', 'outer selection appears in room');
    await page.evaluate(() => HertzRoom.destroy());
    assert.equal(await menu.isVisible(), false, 'destroy closes the shared menu');
    assert.equal(await page.locator('#theme-menu').count(), 1, 'single menu owner');
    console.log('Room theme browser: 200% zoom/reflow/focus, shared search/pagination, queue menu focus/scrolling, aside keyboard navigation, invitation reuse/permissions, song drawer, code applications, inline verification, cover drafts/failures, exits/session isolation, nicknames, stage/danmaku, settings, responsive geometry, themes and LAN favorites passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
