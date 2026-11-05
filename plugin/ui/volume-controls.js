// SPDX-License-Identifier: MIT
// Presentation only: keep each surface's original range and volume command path.
(function () {
  'use strict';
  var controls = [], opened = null, closeTimer = 0;
  var icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-volume"/></svg>';
  function button(label) {
    var node = document.createElement('button'); node.type = 'button';
    node.className = 'hz-volume-button'; node.innerHTML = icon;
    node.setAttribute('aria-label', label); node.title = label; return node;
  }
  function paint(control, value) {
    var amount = Math.round(Math.max(0, Math.min(100, Number(value) || 0)));
    control.output.textContent = amount + '%';
    control.range.setAttribute('aria-valuetext', amount + '%');
    control.range.style.setProperty('--hz-volume-fill', amount + '%');
    control.trigger.setAttribute('aria-label', '音量 ' + amount + '%');
    control.trigger.title = '音量 ' + amount + '%';
    control.trigger.classList.toggle('is-muted', amount === 0);
    if (control.mute) {
      control.mute.title = amount ? '静音' : '取消静音';
      control.mute.setAttribute('aria-label', control.mute.title);
      control.mute.setAttribute('aria-pressed', String(amount === 0));
    }
  }
  function place(control) {
    var rect = control.trigger.getBoundingClientRect(), panel = control.panel;
    var width = panel.offsetWidth || 62, height = panel.offsetHeight || 202;
    var x = Math.max(8, Math.min(innerWidth - width - 8, rect.left + (rect.width - width) / 2));
    var y = rect.top - height - 10;
    if (y < 8) y = Math.min(innerHeight - height - 8, rect.bottom + 10);
    panel.style.left = x + 'px'; panel.style.top = Math.max(8, y) + 'px';
  }
  function close(restoreFocus) {
    clearTimeout(closeTimer); closeTimer = 0;
    if (!opened) return;
    var control = opened; opened = null;
    control.trigger.setAttribute('aria-expanded', 'false');
    control.panel.hidePopover(); control.mode = '';
    if (restoreFocus && !control.trigger.closest('[inert]')) {
      control.ignoreFocus = true; control.trigger.focus({ preventScroll: true }); control.ignoreFocus = false;
    }
  }
  function open(control, mode) {
    clearTimeout(closeTimer); closeTimer = 0;
    if (control.range.disabled) return;
    if (opened && opened !== control) close(false);
    opened = control; control.mode = mode || control.mode || 'hover';
    paint(control, control.range.value); control.panel.showPopover(); place(control);
    control.trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () { if (opened === control) place(control); });
  }
  function deferClose(control) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      if (opened !== control || control.mode === 'click') return;
      if (!control.trigger.matches(':hover') && !control.panel.matches(':hover') &&
          !control.panel.contains(document.activeElement) && document.activeElement !== control.trigger) close(false);
    }, 180);
  }
  function decorate(range, trigger, panel, mute) {
    panel.classList.add('hz-volume-panel');
    range.classList.add('hz-volume-range'); range.setAttribute('aria-orientation', 'vertical');
    var output = document.createElement('output'); output.className = 'hz-volume-value';
    output.htmlFor = range.id; output.setAttribute('aria-hidden', 'true');
    panel.prepend(output); panel.appendChild(range);
    if (mute) { mute.classList.add('hz-volume-mute'); panel.appendChild(mute); }
    var control = { range: range, trigger: trigger, panel: panel, mute: mute, output: output, mode: '' };
    panel.addEventListener('input', function (event) { if (event.target === range) paint(control, range.value); });
    panel.addEventListener('click', function (event) {
      if (mute && mute.contains(event.target)) queueMicrotask(function () { controls.forEach(function (item) { paint(item, item.range.value); }); });
    });
    controls.push(control); paint(control, range.value); return control;
  }
  function mount(id, muteId) {
    var range = document.getElementById(id); if (!range) return;
    var host = range.parentElement;
    // The stage used a label around the range. A disclosure button is not a label.
    if (host.tagName === 'LABEL') {
      var replacement = document.createElement('div'); replacement.className = host.className;
      while (host.firstChild) replacement.appendChild(host.firstChild);
      host.replaceWith(replacement); host = replacement;
    }
    host.classList.add('hz-volume-control');
    var mute = muteId && document.getElementById(muteId);
    Array.from(host.children).forEach(function (node) { if (node !== range && node !== mute) node.remove(); });
    var trigger = button('音量'); trigger.id = id + '-toggle';
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', id + '-panel');
    var panel = document.createElement('div'); panel.id = id + '-panel';
    panel.setAttribute('popover', 'manual'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '音量控制');
    host.append(trigger, panel);
    if (!mute) {
      mute = button('静音');
      // The ordinary player's action also handles room volume and restore level.
      mute.addEventListener('click', function () { var original = document.getElementById('np-mute'); if (original) original.click(); });
    }
    var control = decorate(range, trigger, panel, mute);
    trigger.addEventListener('click', function () {
      if (opened === control && control.mode === 'click') close(false); else open(control, 'click');
    });
    trigger.addEventListener('focus', function () {
      if (!control.ignoreFocus && trigger.matches(':focus-visible')) open(control, 'focus');
    });
    trigger.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation(); open(control, 'focus'); range.focus({ preventScroll: true });
      }
    });
    [trigger, panel].forEach(function (node) {
      node.addEventListener('pointerenter', function (event) {
        clearTimeout(closeTimer); if (event.pointerType === 'mouse' && opened !== control) open(control, 'hover');
      });
      node.addEventListener('pointerleave', function () { deferClose(control); });
      node.addEventListener('focusout', function () { deferClose(control); });
    });
  }
  function mountSpace() {
    var range = document.getElementById('sp-volume'), trigger = document.getElementById('sp-volume-toggle');
    var panel = document.getElementById('sp-volume-panel'); if (!range || !trigger || !panel) return;
    var control = decorate(range, trigger, panel, document.getElementById('sp-mute'));
    control.external = true;
    // Space3D remains the single owner of panel focus, Escape and outside clicks.
    new MutationObserver(function () {
      if (panel.classList.contains('sp-show')) { paint(control, range.value); place(control); }
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  function init() {
    mount('volume'); mount('np-volume', 'np-mute'); mount('s3d-volume'); mountSpace();
    document.addEventListener('pointerdown', function (event) {
      if (opened && !opened.panel.contains(event.target) && !opened.trigger.contains(event.target)) close(false);
    }, true);
    // Close the small control before the stage's document-level Escape handler.
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    }, true);
    document.addEventListener('playback:snapshot', function (event) {
      var volume = event.detail && event.detail.volume;
      if (!Number.isFinite(volume)) return;
      controls.forEach(function (control) { paint(control, document.activeElement === control.range ? control.range.value : volume * 100); });
      if (opened && (opened.trigger.closest('[inert]') || !opened.trigger.checkVisibility())) close(false);
    });
    document.addEventListener('nav:changed', function () { close(false); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) close(false); });
    document.addEventListener('fullscreenchange', function () { close(false); });
    var surfaceObserver = new MutationObserver(function () {
      if (opened && (opened.trigger.closest('[inert], [hidden], [aria-hidden="true"]') || !opened.trigger.checkVisibility())) close(false);
    });
    ['playback-bar', 'np-modal', 'stage3d'].forEach(function (id) {
      var surface = document.getElementById(id);
      if (surface) surfaceObserver.observe(surface, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    });
    window.addEventListener('resize', function () {
      if (opened) place(opened);
      controls.forEach(function (control) { if (control.external && control.panel.classList.contains('sp-show')) place(control); });
    });
  }
  // Deferred scripts run before app.js wires its canonical range listeners.
  init();
  window.HertzVolumeControls = { close: function () { close(false); } };
})();
