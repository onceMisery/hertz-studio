// SPDX-License-Identifier: MIT
// Presentation state only; this module never sends a room operation.
(function (global) {
  'use strict';
  const titles = { lobby: '一起听大厅', play: '房间播放', invite: '邀请一起听', collaborate: '共同队列与聊天', settings: '成员与设置' };
  const symbols = { lobby: 'home', play: 'headphones', invite: 'user', collaborate: 'queue', settings: 'settings' };
  function icon(name) {
    const make = tag => document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    const svg = make('svg'), use = make('use'); svg.setAttribute('class', 'room-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
  }
  global.HertzRoomWorkspace = {
    icon,
    create(root, actions) {
      const { h, refs } = actions;
      function button(text, action, cls) { const node = h('button', 'btn ' + (cls || ''), text); node.type = 'button'; node.onclick = action; return node; }
      let page = actions.active ? 'play' : 'lobby';
      const shell = h('div', 'room-workspace'), sidebar = h('aside', 'room-sidebar');
      const brand = h('div', 'room-brand'); brand.append(h('span', 'room-brand-mark', 'H'), h('div', '', 'Hertz · 一起听'));
      sidebar.append(brand, button('返回 Hertz', actions.onReturn, 'room-back'));
      const nav = h('nav', 'room-navigation'); nav.setAttribute('aria-label', '一起听工作区');
      const pages = {}, navButtons = new Map(), mobileButtons = new Map();
      function navigate(next, focus) {
        if (!pages[next]) return;
        if (global.ThemePicker) global.ThemePicker.close();
        page = next;
        Object.entries(pages).forEach(([key, element]) => { element.hidden = key !== next; });
        [navButtons, mobileButtons].forEach(map => map.forEach((node, key) => { node.classList.toggle('active', key === next); node.setAttribute('aria-current', key === next ? 'page' : 'false'); }));
        refs.pageTitle.textContent = titles[next];
        root.dataset.roomPage = next;
        if (focus) refs.pageTitle.focus({ preventScroll: true });
      }
      Object.keys(titles).forEach(key => {
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
      content.append(button('‹ 返回 Hertz', actions.onReturn, 'room-mobile-back'));
      const header = h('header', 'room-header'), heading = h('div');
      refs.roomEyebrow = h('div', 'room-kicker', 'HERTZ / LISTEN TOGETHER'); refs.title = h('h1', '', '一起听');
      refs.pageTitle = h('h2', 'room-page-title', titles[page]); refs.pageTitle.tabIndex = -1;
      refs.roomSummary = h('p', 'room-sub', '与同一网络里的电脑分享音乐'); heading.append(refs.roomEyebrow, refs.title, refs.roomSummary);
      const headerActions = h('div', 'room-header-actions');
      const themeField = h('div', 'room-theme-picker');
      const themeButton = h('button', 'iconbtn room-theme-button');
      themeButton.type = 'button'; themeButton.title = '主题色'; themeButton.setAttribute('aria-label', '切换主题色');
      themeButton.append(icon('palette')); themeField.append(themeButton); headerActions.append(themeField);
      const themeBinding = global.ThemePicker && global.ThemePicker.bind(themeButton);
      themeField.hidden = !themeBinding;
      refs.health = button('查看输出详情', () => navigate('settings', true), 'room-health');
      refs.inviteNav = button('+ 邀请一起听', () => navigate('invite', true), 'primary'); headerActions.append(refs.health, refs.inviteNav);
      header.append(heading, headerActions); content.append(header, refs.pageTitle);
      refs.notice = h('p', 'room-notice'); refs.notice.setAttribute('role', 'status'); refs.notice.setAttribute('aria-live', 'polite'); refs.notice.hidden = true; content.append(refs.notice);
      Object.keys(titles).forEach(key => { const element = h('section', 'room-page room-page-' + key); element.setAttribute('aria-label', titles[key]); pages[key] = element; content.append(element); });
      const mobile = h('nav', 'room-mobile-navigation'); mobile.setAttribute('aria-label', '一起听页面');
      [['lobby', '大厅'], ['play', '播放'], ['collaborate', '队列·聊天'], ['invite', '邀请'], ['settings', '设置']].forEach(([key, title]) => {
        const node = button(title, () => navigate(key, true), 'room-mobile-item'); node.prepend(icon(symbols[key])); mobile.append(node); mobileButtons.set(key, node);
      });
      shell.append(sidebar, content, mobile); root.append(shell);
      if (!actions.active) {
        ['play', 'invite', 'collaborate', 'settings'].forEach(key => {
          const empty = h('div', 'room-empty-state'); empty.append(h('h3', '', '从一间音乐房间开始'), h('p', 'room-sub', '创建房间，或使用房主发来的邀请加入。'), button('前往大厅', () => navigate('lobby', true), 'primary')); pages[key].append(empty);
        });
      }
      navigate(page);
      return {
        pages, navigate,
        destroy() { if (themeBinding) themeBinding.destroy(); },
        render(snapshot) {
          const active = snapshot.mode !== 'local', output = snapshot.output || {};
          refs.title.textContent = active ? snapshot.name || '一起听房间' : '发现此刻的同频';
          refs.roomEyebrow.textContent = active ? snapshot.mode === 'host' ? '房主 · 房间进行中' : snapshot.mode === 'guest' ? '已加入房间' : '正在恢复房间连接' : 'HERTZ / LISTEN TOGETHER';
          refs.sidebarName.textContent = active ? snapshot.name || '一起听房间' : '尚未加入房间';
          const count = snapshot.online_count == null ? (snapshot.members || []).length : snapshot.online_count;
          const summary = active ? count + ' 位成员 · ' + (snapshot.mode === 'host' ? '你是房主' : snapshot.mode === 'guest' ? '已连接' : '连接待恢复') : '创建一间房，或寻找附近正在分享的音乐';
          const duration = snapshot.elapsed_ms == null ? '' : ' · 已持续 ' + Math.floor(Number(snapshot.elapsed_ms) / 60000) + ' 分钟';
          refs.roomSummary.textContent = summary + duration; refs.sidebarStatus.textContent = summary;
          refs.health.hidden = !active; refs.inviteNav.hidden = !active;
          refs.health.classList.toggle('healthy', !!output.enabled && !!output.ready && !output.error && (snapshot.mode === 'host' || snapshot.mode === 'guest'));
          refs.health.textContent = output.error ? '输出异常 · 查看详情' : !output.enabled ? '本机音频已关闭' : output.ready ? '输出时钟已就绪' : '等待对时 · 查看详情';
        },
        currentPage() { return page; }
      };
    }
  };
})(window);
