// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 布局生命周期和业务请求桥。副本只提供 HertzStudio 布局；保留扩展接口，
// 让桌面与插件宿主继续共享 CSS 启用、偏好恢复和有序装配。

(function () {
  'use strict';

  var ATTR = 'data-skin';
  var KEY = 'vmusic.skin';
  var DEFAULT_ID = 'hertz';
  var FALLBACK_ID = 'hertz';
  var DEFAULT_MARKER = 'vmusic.skin.default';
  var EVENT = 'skin:changed';
  var CATALOG = [{ id: 'hertz', name: 'HertzStudio', note: '音乐播放器 · 桌面与移动端 · 封面拼接墙' }];

  var current = DEFAULT_ID;
  var listeners = [];
  var activeLifecycle = null;
  var initialized = false;
  var host = null;

  function validLifecycle(value) {
    return value && typeof value.mount === 'function' && typeof value.unmount === 'function';
  }

  function setSurface(id) {
    var root = document.documentElement;
    if (root.getAttribute(ATTR) !== id) root.setAttribute(ATTR, id);
    syncCss(id);
  }

  // Hooks own their DOM resources; this owner guarantees teardown before mount.
  // A failed mount is cleaned up before restoring the previous layout.
  function transition(def) {
    var next = def.lifecycle || null;
    if (initialized && current === def.id && activeLifecycle === next) return;
    var previous = current, old = activeLifecycle;
    if (window.NowPlaying && window.NowPlaying.isOpen()) {
      window.NowPlaying.close({ switching: true });
      var player = document.getElementById('np-modal');
      var scrim = document.getElementById('np-scrim');
      if (player) player.hidden = true;
      if (scrim) scrim.hidden = true;
    }
    if (old) old.unmount();
    activeLifecycle = null;
    setSurface(def.id);
    current = def.id;
    try {
      if (next) next.mount();
      activeLifecycle = next;
      initialized = true;
    } catch (error) {
      try { if (next) next.unmount(); }
      finally {
        current = previous;
        setSurface(previous);
        // 恢复也可能只完成部分挂载；先记 owner，后续换肤仍能调用清理。
        activeLifecycle = old;
        if (old) old.mount();
      }
      throw error;
    }
  }

  function registerLifecycle(id, value) {
    var def = byId(id);
    if (!def || def.lifecycle || !validLifecycle(value)) return false;
    def.lifecycle = { mount: value.mount, unmount: value.unmount };
    if (initialized && current === id) transition(def);
    return true;
  }

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i += 1) {
      if (CATALOG[i].id === id) return CATALOG[i];
    }
    return null;
  }

  // 命令面板及扩展调用方只读取可见描述。
  function visible() {
    return CATALOG.filter(function (d) { return !d.hidden; });
  }

  // 独立服务使用 link，DBX srcdoc 将其转换为 style；两者都支持 disabled。
  function sheets() {
    return document.querySelectorAll('link[data-skin-css], style[data-skin-css]');
  }

  function syncCss(id) {
    var links = sheets();
    for (var i = 0; i < links.length; i += 1) {
      var own = links[i].getAttribute('data-skin-css');
      var want = own === id;
      if (links[i].disabled === want) links[i].disabled = !want;
    }
  }

  function hasCss(id) {
    var links = sheets();
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].getAttribute('data-skin-css') === id) return true;
    }
    return false;
  }

  function apply(id, opts) {
    var def = byId(id);
    if (!def) {
      def = byId(FALLBACK_ID);
      id = FALLBACK_ID;
    }
    // 扩展缺失 CSS 时保留可用的默认布局。
    if (id !== FALLBACK_ID && !hasCss(id)) {
      if (window.console && console.warn) console.warn('[skins] 缺少 ' + id + ' 的 CSS，回落到 ' + FALLBACK_ID);
      id = FALLBACK_ID;
      def = byId(FALLBACK_ID);
    }

    transition(def);

    if (!(opts && opts.silent)) {
      try { localStorage.setItem(KEY, id); } catch (e) { /* 隐私模式 */ }
    }
    // 舞台画布、3D 场景这些要按新尺寸重排，广播出去让它们自己响应——
    // 与项目里 online-playlists:changed 的做法一致，不在这里硬编码谁要重画。
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: { id: id, skin: def } }));
    } catch (e) { /* 老浏览器没有 CustomEvent 构造器 */ }
    listeners.forEach(function (fn) {
      try { fn(def); } catch (e) { /* 单个订阅者出错不该拖垮换肤 */ }
    });
    return def;
  }

  function init() {
    var saved = null;
    var firstDefault = false;
    try {
      saved = localStorage.getItem(KEY);
      firstDefault = localStorage.getItem(DEFAULT_MARKER) === null;
    } catch (e) { saved = null; }
    var def = saved ? byId(saved) : null;
    // 旧布局及隐藏扩展的保存值迁移到默认布局。
    var start = def && !def.hidden ? saved : DEFAULT_ID;
    if (firstDefault) {
      if (!saved || saved === FALLBACK_ID) start = DEFAULT_ID;
      try {
        localStorage.setItem(KEY, start);
        localStorage.setItem(DEFAULT_MARKER, DEFAULT_ID);
      } catch (e) { /* 隐私模式下只影响本次启动 */ }
    }
    apply(start, { silent: true });
    if (saved && (!def || def.hidden)) {
      // init 走 silent 不写盘，这里补一次，避免下次继续读取无效偏好。
      try { localStorage.setItem(KEY, start); } catch (e) { /* 隐私模式 */ }
    }
    return current;
  }

  window.Skins = {
    // 保留外部扩展的登记接口；本项目不再附带其它布局文件。
    register: function (def) {
      if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.id) || byId(def.id)) return false;
      if (def.lifecycle && !validLifecycle(def.lifecycle)) return false;
      var entry = { id: def.id, name: def.name || def.id, note: def.note || '' };
      if (def.hidden) entry.hidden = true;
      if (def.lifecycle) entry.lifecycle = { mount: def.lifecycle.mount, unmount: def.lifecycle.unmount };
      CATALOG.push(entry);
      return true;
    },
    registerLifecycle: registerLifecycle,
    // One synchronous request contract supports actions and read-only snapshots.
    // The app owns its handler; individual skins never register business listeners.
    connectHost: function (handler) {
      if (typeof handler !== 'function') throw new TypeError('Skin host must be a function');
      host = handler;
      return function () { if (host === handler) host = null; };
    },
    request: function (action, extra) {
      var detail = Object.assign({}, extra || {}, { action: action });
      if (host) host(detail);
      return detail;
    },
    list: function () {
      return visible().map(function (d) { return { id: d.id, name: d.name, note: d.note }; });
    },
    apply: apply,
    current: function () { return byId(current); },
    currentId: function () { return current; },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () { var at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
    },
    init: init,
    render: function () {}, // 旧宿主接口；唯一布局没有选择器。
    catalog: function () { return CATALOG.slice(); },
  };
})();
