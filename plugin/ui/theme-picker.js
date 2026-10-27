// SPDX-License-Identifier: MIT
// One palette menu shared by the application and listening workspace.
(function (global) {
  'use strict';
  const triggers = new Set();
  let menu, anchor, applyTheme = id => global.Theme.apply(id);
  function themeDotStyle(theme) {
    return `--t-bg:${theme.tokens['--bg']};--t-accent:${theme.tokens['--accent']};--t-accent-2:${theme.tokens['--accent-2']}`;
  }
  function close(restoreFocus) {
    if (!menu) return;
    menu.hidden = true;
    triggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
    anchor = null;
  }
  function position() {
    if (!menu || menu.hidden || !anchor) return;
    const r = anchor.getBoundingClientRect(), pad = 8, gap = 8;
    const width = menu.offsetWidth, height = menu.offsetHeight;
    let top = r.bottom + gap;
    if (top + height > innerHeight - pad && r.top - height - gap >= pad) top = r.top - height - gap;
    menu.style.left = Math.max(pad, Math.min(r.right - width, innerWidth - width - pad)) + 'px';
    menu.style.top = Math.max(pad, Math.min(top, innerHeight - height - pad)) + 'px';
  }
  function render() {
    const focusedId = menu.contains(document.activeElement) && document.activeElement.dataset.themeId;
    const selected = global.Theme.current();
    menu.replaceChildren();
    global.Theme.list().forEach(theme => {
      const button = document.createElement('button'), dot = document.createElement('span'), name = document.createElement('span');
      button.type = 'button'; button.className = 'theme-item'; button.dataset.themeId = theme.id;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(!!selected && theme.id === selected.id));
      button.tabIndex = selected && theme.id === selected.id ? 0 : -1;
      dot.className = 'theme-dot'; dot.style.cssText = themeDotStyle(theme); dot.setAttribute('aria-hidden', 'true');
      name.className = 'theme-name'; name.textContent = theme.name;
      button.append(dot, name);
      button.onclick = () => { applyTheme(theme.id); close(true); };
      menu.append(button);
    });
    if (focusedId) {
      const target = Array.from(menu.children).find(button => button.dataset.themeId === focusedId);
      if (target) target.focus({ preventScroll: true });
    }
    position();
  }
  function focusItem(index) {
    const items = Array.from(menu.children);
    const target = items[(index + items.length) % items.length];
    if (!target) return;
    items.forEach(item => { item.tabIndex = item === target ? 0 : -1; });
    target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' });
  }
  function open(button, focus) {
    close(false); anchor = button;
    render(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); position();
    document.dispatchEvent(new CustomEvent('topbar:popup', { detail: { id: 'theme' } }));
    if (focus) focusItem(Math.max(0, Array.from(menu.children).findIndex(item => item.getAttribute('aria-selected') === 'true')));
  }
  function ensureMenu() {
    if (menu) return;
    menu = document.getElementById('theme-menu');
    document.body.appendChild(menu);
    global.Theme.onChange(render);
    document.addEventListener('click', event => {
      if (!menu.hidden && !menu.contains(event.target) && (!anchor || !anchor.contains(event.target))) close(false);
    });
    document.addEventListener('keydown', event => {
      if (menu.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'Tab') close(false);
    });
    menu.addEventListener('keydown', event => {
      const index = Array.from(menu.children).indexOf(document.activeElement);
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      focusItem(event.key === 'Home' ? 0 : event.key === 'End' ? menu.children.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
    });
    document.addEventListener('topbar:popup', event => { if (event.detail && event.detail.id !== 'theme') close(false); });
    global.addEventListener('resize', position);
    // Keep the portal attached to its trigger, including browser focus scrolling.
    document.addEventListener('scroll', position, true);
    render();
  }
  global.ThemePicker = {
    themeDotStyle,
    configure(options) { applyTheme = options.apply; },
    bind(button) {
      ensureMenu(); triggers.add(button);
      button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', 'false');
      const click = event => { event.stopPropagation(); if (anchor === button && !menu.hidden) close(false); else open(button, true); };
      const keydown = event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(button, true); }
      };
      button.addEventListener('click', click); button.addEventListener('keydown', keydown);
      return { destroy() {
        if (anchor === button) close(false);
        triggers.delete(button); button.removeEventListener('click', click); button.removeEventListener('keydown', keydown);
      } };
    },
    close() { close(false); }
  };
})(window);
