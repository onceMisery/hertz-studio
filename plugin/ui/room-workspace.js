// SPDX-License-Identifier: MIT
// Presentation state only; this module never sends a room operation.
(function (global) {
  'use strict';
  const titles = { lobby: '一起听', discover: '附近的房间', application: '入房申请', play: '听歌现场', invite: '邀请一起听', collaborate: '共同队列与聊天', settings: '房间设置', summary: '收听小结' };
  const symbols = { lobby: 'home', play: 'headphones', invite: 'user', collaborate: 'queue', settings: 'settings' };
  function icon(name) {
    const make = tag => document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    const svg = make('svg'), use = make('use'); svg.setAttribute('class', 'room-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    if (name === 'crown') { const path = make('path'); path.setAttribute('d', 'M3 6l5 4 4-6 4 6 5-4-2 13H5L3 6z'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); svg.append(path); }
    else { use.setAttribute('href', '#i-' + name); svg.append(use); } return svg;
  }
  // Native popovers live above scrolling panels and modal drawers. Their DOM
  // stays with the owning row so redraws can restore the same action's focus.
  function createMenu(h, label, className = 'room-track-more') {
    const node = h('details', className), toggle = h('summary'), panel = h('div', 'room-track-actions');
    toggle.append(icon('more'), h('span', 'room-visually-hidden', '更多'));
    toggle.setAttribute('aria-label', label); toggle.title = label;
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false');
    panel.setAttribute('popover', 'auto'); panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', label);
    node.append(toggle, panel);
    const buttons = () => [...panel.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length);
    let anchorPosition;
    const release = () => { global.removeEventListener?.('resize', dismiss); global.removeEventListener?.('scroll', scrolled, true); };
    const close = (restore = false) => {
      panel.hidePopover?.(); node.open = false; toggle.setAttribute('aria-expanded', 'false'); release();
      if (restore && toggle.isConnected) toggle.focus({ preventScroll: true });
    };
    const dismiss = () => close();
    const scrolled = event => {
      if (panel.contains(event.target)) return;
      const box = toggle.getBoundingClientRect();
      if (anchorPosition && (Math.abs(box.x - anchorPosition.x) > 1 || Math.abs(box.y - anchorPosition.y) > 1)) close();
    };
    const open = (focus = false) => {
      node.open = true;
      panel.querySelectorAll('button').forEach(button => button.setAttribute('role', 'menuitem'));
      // getBoundingClientRect includes CSS zoom; fixed offsets do not.
      const anchor = toggle.getBoundingClientRect(), scale = anchor.width / toggle.offsetWidth || 1, gap = 8 * scale, edge = 12 * scale;
      anchorPosition = { x: anchor.x, y: anchor.y };
      const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
      panel.style.maxHeight = Math.max(80, (height - edge * 2) / scale) + 'px';
      panel.style.animation = 'none';
      panel.showPopover(); toggle.setAttribute('aria-expanded', 'true');
      const box = panel.getBoundingClientRect();
      const menuHeight = Math.min(box.height, height - edge * 2);
      const x = Math.max(edge, Math.min(anchor.right - box.width, width - box.width - edge));
      const y = anchor.bottom + gap + menuHeight <= height - edge ? anchor.bottom + gap : Math.max(edge, anchor.top - gap - menuHeight);
      panel.style.left = x / scale + 'px'; panel.style.top = y / scale + 'px';
      panel.style.animation = '';
      global.addEventListener('resize', dismiss); global.addEventListener('scroll', scrolled, true);
      if (focus) buttons()[0]?.focus({ preventScroll: true });
    };
    toggle.onclick = event => { event.preventDefault(); node.open ? close() : open(event.detail === 0); };
    toggle.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); const entries = buttons(); (event.key === 'ArrowUp' ? entries.at(-1) : entries[0])?.focus({ preventScroll: true }); }
    };
    panel.onbeforetoggle = event => { if (event.newState === 'closed') { node.open = false; toggle.setAttribute('aria-expanded', 'false'); release(); } };
    panel.onkeydown = event => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const entries = buttons(), index = entries.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      entries[next]?.focus({ preventScroll: true });
    };
    node.closeMenu = close;
    return { node, panel, open, close };
  }
  function closeMenus(parent) { parent.querySelectorAll('details[open]').forEach(node => { if (node.closeMenu) node.closeMenu(); }); }
  global.HertzRoomWorkspace = {
    icon, createMenu, closeMenus,
    create(root, actions) {
      const { h, refs } = actions;
      function button(text, action, cls) { const node = h('button', 'btn ' + (cls || ''), text); node.type = 'button'; node.onclick = action; return node; }
      let page = actions.active ? 'play' : 'lobby';
      const shell = h('div', 'room-workspace'), sidebar = h('aside', 'room-sidebar');
      const brand = h('div', 'room-brand'); brand.append(h('span', 'room-brand-mark', 'H'), h('div', '', 'Hertz · 一起听'));
      sidebar.append(brand, button('返回 Hertz', actions.onReturn, 'room-back'));
      const nav = h('nav', 'room-navigation'); nav.setAttribute('aria-label', '一起听工作区');
      const pages = {}, navButtons = new Map(), mobileButtons = new Map();
      const entryDialogs = [];
      function closeEntryDialogs() { closeMenus(root); entryDialogs.forEach(dialog => dialog.close()); }
      function createEntryDialog(key, title) {
        const node = h('dialog', 'room-entry-dialog' + (/panel|picker/.test(key) ? ' room-drawer' : '')), head = h('header', 'room-entry-dialog-head');
        const heading = h('h2', '', title); heading.id = 'room-entry-title-' + key;
        node.setAttribute('aria-labelledby', heading.id);
        const body = h('div', 'room-entry-dialog-body'), notice = h('p', 'room-notice');
        notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
        let opener, scrollTop = 0, overflow, confirmResolve;
        const verification = h('section', 'room-verification'); verification.hidden = true;
        const dialog = {
          body, node,
          isOpen: () => !!node.open,
          opener: () => opener,
          open(field, returnFocus) {
            if (node.open) return;
            closeEntryDialogs();
            opener = returnFocus || document.activeElement; scrollTop = root.scrollTop; overflow = root.style.overflow;
            if (global.ThemePicker) global.ThemePicker.close();
            refs.entryNotice = notice; notice.hidden = true; root.style.overflow = 'hidden';
            node.showModal();
            if (field) field.focus({ preventScroll: true });
            root.scrollTop = scrollTop;
          },
          close() {
            if (!node.open) return;
            if (dialog.onClose) dialog.onClose();
            if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
            verification.hidden = true; body.hidden = false;
            node.close();
            root.style.overflow = overflow;
            if (refs.entryNotice === notice) refs.entryNotice = null;
            if (opener && opener.isConnected) opener.focus({ preventScroll: true });
            root.scrollTop = scrollTop;
          },
          confirm(message) {
            if (confirmResolve) return Promise.resolve(false);
            const previousFocus = document.activeElement;
            body.hidden = true; verification.hidden = false; verification.replaceChildren();
            verification.append(h('h3', '', '核对房主身份'), h('p', 'room-sub', '请与房主核对完整指纹，附近发现和昵称不能证明身份。'), h('pre', 'room-pin', message));
            return new Promise(resolve => {
              const done = accepted => { confirmResolve = null; verification.hidden = true; body.hidden = false; if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); resolve(accepted); };
              confirmResolve = resolve;
              const cancel = button('返回修改', () => done(false));
              const accept = button('已核对，继续', () => done(true), 'primary');
              verification.append(cancel, accept); accept.focus({ preventScroll: true });
            });
          }
        };
        const close = button('关闭', () => dialog.close(), 'room-entry-dialog-close'); close.setAttribute('aria-label', '关闭' + title);
        head.append(heading, close); body.append(notice); node.append(head, body, verification); root.append(node);
        node.oncancel = event => { event.preventDefault(); dialog.close(); };
        node.onkeydown = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
          if (event.key === 'Tab') {
            const fields = [...node.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(field => field.getClientRects().length);
            const target = event.shiftKey && document.activeElement === fields[0] ? fields.at(-1) : !event.shiftKey && document.activeElement === fields.at(-1) ? fields[0] : null;
            if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
          }
        };
        node.onclick = event => {
          if (event.target !== node) return;
          const box = node.getBoundingClientRect();
          if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
        };
        entryDialogs.push(dialog); return dialog;
      }
      const leaveDialog = actions.active ? createEntryDialog('leave', '退出房间？') : null;
      function confirmLeave(snapshot, summary) {
        if (!leaveDialog || leaveDialog.isOpen()) return Promise.resolve(false);
        const host = snapshot.mode === 'host', members = (snapshot.members || []).filter(member => !member.owner && member.id !== snapshot.member_id);
        leaveDialog.node.querySelector('h2').textContent = host ? '结束这间房间？' : '退出房间？';
        leaveDialog.body.replaceChildren(h('p', 'room-sub', host
          ? '结束后，' + members.length + ' 位成员的连接将同时断开，大家将停止同步收听。'
          : '退出后会断开同步，需要重新获得邀请或房主批准才能回来。其他成员可以继续收听。'));
        const detail = h('div', 'room-flow-card');
        detail.append(h('p', '', host ? '将断开：' + (members.map(member => member.name).join(' · ') || '当前没有其他成员') : '只是想安静一会儿？把本机音量调到 0，其他人不会受影响。'));
        if (summary) detail.append(h('p', 'room-sub', '本次已持续 ' + Math.floor(summary.elapsed_ms / 60000) + ' 分钟 · 听过 ' + summary.tracks.length + ' 首歌'));
        leaveDialog.body.append(detail);
        const showSummary = h('input'); showSummary.type = 'checkbox'; showSummary.checked = true;
        if (host) { const preference = h('label', 'room-field', '结束后给我一份收听小结'); preference.append(showSummary); leaveDialog.body.append(preference); }
        return new Promise(resolve => {
          leaveDialog.onClose = () => { leaveDialog.onClose = null; resolve(false); };
          const done = value => { leaveDialog.onClose = null; leaveDialog.close(); resolve(value); };
          const footer = h('div', 'room-dialog-actions');
          footer.append(button(host ? '继续一起听' : '继续听', () => done(false)), button(host ? '结束房间' : '退出房间', () => done({ showSummary: showSummary.checked }), 'room-danger'));
          leaveDialog.body.append(footer); leaveDialog.open();
        });
      }
      let settingsEntries = [], settingsPane;
      function selectSettings(key, focus) {
        const target = settingsEntries.find(entry => entry.key === key && !entry.tab.hidden);
        if (!target) return;
        pages.settings.dataset.setting = key;
        settingsEntries.forEach(entry => {
          const selected = entry === target;
          entry.panel.hidden = !selected;
          entry.tab.setAttribute('aria-selected', String(selected));
          entry.tab.tabIndex = selected ? 0 : -1;
        });
        if (settingsPane) settingsPane.scrollTop = 0;
        if (focus) {
          target.tab.focus({ preventScroll: true });
          if (target.tab.scrollIntoView) target.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      function openSettings(key) { navigate('settings', true); selectSettings(key); }
      function createSettings(groups) {
        const tabs = h('div', 'room-settings-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '房间设置分类');
        settingsPane = h('div', 'room-settings-content');
        const panels = {};
        settingsEntries = groups.map(([key, label, hostOnly]) => {
          const tab = button(label, () => selectSettings(key), 'room-settings-tab');
          tab.id = 'room-settings-tab-' + key; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'room-settings-panel-' + key);
          const panel = h('div', 'room-settings-panel'); panel.id = 'room-settings-panel-' + key;
          panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
          panels[key] = panel; tabs.append(tab); settingsPane.append(panel);
          tab.onkeydown = event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const visible = settingsEntries.filter(entry => !entry.tab.hidden), index = visible.findIndex(entry => entry.key === key);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
            selectSettings(visible[next].key, true);
          };
          return { key, tab, panel, hostOnly };
        });
        pages.settings.append(tabs, settingsPane); selectSettings(groups[0][0]);
        return panels;
      }
      function navigate(next, focus) {
        if (!pages[next]) return;
        if (actions.active && next === 'invite' && inviteDialog) { pages.invite.hidden = false; inviteDialog.open(); return; }
        if (actions.active && next === 'collaborate' && refs.selectTab) { next = 'play'; refs.selectTab('queue'); }
        closeEntryDialogs();
        if (global.ThemePicker) global.ThemePicker.close();
        page = next;
        Object.entries(pages).forEach(([key, element]) => { element.hidden = key === 'invite' && actions.active ? false : key !== next; });
        [navButtons, mobileButtons].forEach(map => map.forEach((node, key) => { node.classList.toggle('active', key === next); node.setAttribute('aria-current', key === next ? 'page' : 'false'); }));
        refs.pageTitle.textContent = titles[next];
        root.dataset.roomPage = next;
        if (refs.placeChatComposer) refs.placeChatComposer(next === 'play' && root.dataset.roomAside === 'chat' ? 'chat' : next);
        if (refs.danmaku) refs.danmaku.replaceChildren();
        if (refs.notice && refs.notice.textContent === '操作已受理') { refs.notice.textContent = ''; refs.notice.hidden = true; }
        if (refs.renderEntryPage) refs.renderEntryPage(next);
        if (focus) refs.pageTitle.focus({ preventScroll: true });
      }
      ['lobby', 'play', 'settings'].forEach(key => {
        const node = button(titles[key], () => navigate(key, true), 'room-nav-item');
        node.prepend(icon(symbols[key]));
        nav.append(node); navButtons.set(key, node);
      });
      sidebar.append(nav);
      const current = h('section', 'room-sidebar-current'); current.append(h('small', 'room-kicker', '当前房间'));
      refs.sidebarName = h('strong', '', '尚未加入房间'); refs.sidebarStatus = h('p', 'room-sub', '发现身边的音乐'); current.append(refs.sidebarName, refs.sidebarStatus); sidebar.append(current);
      const appLinks = h('div', 'room-app-links');
      [['library', '我的音乐库'], ['favorites', '我的收藏']].forEach(([name, title]) => appLinks.append(button(title, () => actions.onNavigate(name), 'room-nav-item')));
      sidebar.append(appLinks, h('p', 'room-sidebar-foot room-sub', '音乐在此刻，与你同频。'));
      const content = h('main', 'room-content');
      shell.onkeydown = event => {
        if (event.key !== 'Escape' || !event.target.closest) return;
        const menu = event.target.closest('.room-more[open],.room-track-more[open]');
        if (menu) { event.preventDefault(); event.stopPropagation(); if (menu.closeMenu) menu.closeMenu(true); else { menu.open = false; const summary = menu.querySelector('summary'); if (summary) summary.focus(); } }
      };
      const context = h('div', 'room-context');
      context.append(button('‹ 返回 Hertz', actions.onReturn, 'room-mobile-back'), nav);
      content.append(context);
      const header = h('header', 'room-header'), heading = h('div', 'room-header-title');
      refs.roomEyebrow = h('div', 'room-kicker'); refs.roomEyebrow.hidden = true; refs.title = h('h1', '', '一起听');
      refs.pageTitle = h('h2', 'room-page-title', titles[page]); refs.pageTitle.tabIndex = -1;
      refs.roomSummary = h('p', 'room-sub', '与同一网络里的电脑分享音乐'); heading.append(refs.roomEyebrow, refs.title, refs.roomSummary);
      const headerActions = h('div', 'room-header-actions');
      const themeField = h('div', 'room-theme-picker');
      const themeButton = h('button', 'iconbtn room-theme-button');
      themeButton.type = 'button'; themeButton.title = '主题色'; themeButton.setAttribute('aria-label', '切换主题色');
      themeButton.append(icon('palette')); themeField.append(themeButton); headerActions.append(themeField);
      const themeBinding = global.ThemePicker && global.ThemePicker.bind(themeButton);
      themeField.hidden = !themeBinding;
      refs.health = button('查看输出详情', () => openSettings('output'), 'room-health');
      refs.mobileHealth = button('查看输出详情', () => openSettings('output'), 'room-mobile-health'); heading.append(refs.mobileHealth);
      refs.inviteNav = button('+ 邀请一起听', () => navigate('invite', true), 'primary'); headerActions.append(refs.health, refs.inviteNav);
      const settingsButton = button('房间设置', () => activeSettings(), 'room-header-settings');
      settingsButton.prepend(icon('settings')); headerActions.append(settingsButton);
      function activeSettings() { if (actions.active) openSettings('members'); else if (refs.openEntrySettings) refs.openEntrySettings(); }
      const headerMenu = createMenu(h, '更多房间操作', 'room-more'), more = headerMenu.node, moreActions = headerMenu.panel;
      moreActions.append(button('房间设置', () => { headerMenu.close(); openSettings('members'); }), button('查看附近房间', () => { headerMenu.close(); navigate('lobby', true); }));
      refs.headerLeave = button('离开房间', () => { headerMenu.close(); actions.leaveRoom(); }, 'room-leave room-header-leave'); moreActions.append(refs.headerLeave); headerActions.append(more);
      header.append(context, heading, headerActions); content.append(header, refs.pageTitle);
      refs.notice = h('p', 'room-notice'); refs.notice.setAttribute('role', 'status'); refs.notice.setAttribute('aria-live', 'polite'); refs.notice.hidden = true; content.append(refs.notice);
      Object.keys(titles).forEach(key => { const element = h('section', 'room-page room-page-' + key); element.setAttribute('aria-label', titles[key]); pages[key] = element; content.append(element); });
      const mobile = h('nav', 'room-mobile-navigation'); mobile.hidden = true;
      const inviteDialog = actions.active ? createEntryDialog('invite-panel', '邀请一起听') : null;
      if (inviteDialog) { inviteDialog.body.append(pages.invite); pages.invite.hidden = false; }
      shell.append(sidebar, content, mobile); root.append(shell);
      if (!actions.active) {
        ['play', 'invite', 'collaborate', 'settings'].forEach(key => {
          const empty = h('div', 'room-empty-state'); empty.append(h('h3', '', '从一间音乐房间开始'), h('p', 'room-sub', '创建房间，或使用房主发来的邀请加入。'), button('前往大厅', () => navigate('lobby', true), 'primary')); pages[key].append(empty);
        });
      }
      navigate(page);
      return {
        pages, navigate, createSettings, openSettings, selectSettings, createEntryDialog, closeEntryDialogs, confirmLeave, hasOpenEntry: () => entryDialogs.some(dialog => dialog.isOpen()),
        destroy() { closeEntryDialogs(); if (themeBinding) themeBinding.destroy(); },
        render(snapshot) {
          const active = snapshot.mode !== 'local', output = snapshot.output || {};
          root.dataset.roomActive = String(active);
          navButtons.forEach((node, key) => { node.hidden = !active && key !== 'lobby'; });
          settingsEntries.forEach(entry => { entry.tab.hidden = !!entry.hostOnly && snapshot.mode !== 'host'; });
          if (settingsEntries.length && !settingsEntries.some(entry => entry.key === pages.settings.dataset.setting && !entry.tab.hidden)) selectSettings('members');
          refs.title.textContent = active ? snapshot.name || '一起听房间' : '一起听';
          refs.roomEyebrow.hidden = !active;
          refs.roomEyebrow.textContent = active ? snapshot.mode === 'host' ? '房主 · 房间进行中' : snapshot.mode === 'guest' ? '已加入房间' : '正在恢复房间连接' : '';
          refs.sidebarName.textContent = active ? snapshot.name || '一起听房间' : '尚未加入房间';
          const count = snapshot.online_count == null ? (snapshot.members || []).length : snapshot.online_count;
          const summary = active ? count + ' 位成员 · ' + (snapshot.mode === 'host' ? '你是房主' : snapshot.mode === 'guest' ? '已连接' : '连接待恢复') : '在同一局域网内创建或加入房间，同步听歌。';
          const duration = !active || snapshot.elapsed_ms == null ? '' : ' · 已持续 ' + Math.floor(Number(snapshot.elapsed_ms) / 60000) + ' 分钟';
          refs.roomSummary.textContent = summary + duration; refs.sidebarStatus.textContent = summary;
          refs.health.hidden = !active; refs.inviteNav.hidden = !active;
          more.hidden = !active; refs.headerLeave.hidden = !active; refs.headerLeave.textContent = snapshot.mode === 'host' ? '结束一起听' : '离开房间';
          refs.health.classList.toggle('healthy', !!output.enabled && !!output.ready && !output.error && (snapshot.mode === 'host' || snapshot.mode === 'guest'));
          const muted = output.settings && Number(output.settings.volume) === 0;
          refs.health.textContent = snapshot.mode === 'disconnected' ? '连接已断开 · 查看房间设置' : snapshot.mode === 'reconnecting' ? '连接中断 · 正在重连' : output.error ? '声音暂时中断' : !output.enabled ? '本机未开启声音' : muted ? '本机已静音' : output.ready ? (snapshot.playing ? '可收听' : '已加入 · 等待播放') : '正在准备声音';
          refs.health.title = output.binding ? '本机设备：' + output.binding.device : '查看本机声音设置';
          refs.mobileHealth.hidden = !active; refs.mobileHealth.textContent = refs.health.textContent; refs.mobileHealth.title = refs.health.title;
        },
        currentPage() { return page; }
      };
    }
  };
})(window);
