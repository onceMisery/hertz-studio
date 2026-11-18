// SPDX-License-Identifier: MIT
// The splash observes existing page loads; their modules keep the data and own
// retries. No second request cache or audio download is created at startup.
(function () {
  'use strict';
  if (new URLSearchParams(location.search).has('dbxPluginWindow')) return;

  var MAX_WAIT = 8000;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var tasks = new Map([
    ['app', { label: '播放器', state: 'loading' }],
    ['online', { label: '在线歌曲', state: 'waiting' }],
    ['daily', { label: '首页推荐', state: 'waiting' }],
    ['daily-view', { label: '每日推荐', state: 'waiting' }],
  ]);
  var appReady = false;
  var released = false;
  var dismissed = false;
  var outcome = 'loading';
  var attached = false;
  var frameSettled = false;
  var inertElements = new Map();
  var watchdog;

  var overlay = document.createElement('div');
  overlay.className = 'hertz-startup';
  overlay.setAttribute('aria-label', '正在启动 Hertz Studio');
  var fallback = document.createElement('div');
  fallback.className = 'hertz-startup-fallback';
  var brand = document.createElement('p');
  brand.className = 'hertz-startup-brand';
  brand.textContent = 'Hertz Studio';
  var status = document.createElement('p');
  status.className = 'hertz-startup-status';
  status.setAttribute('role', 'status');
  status.textContent = '正在启动播放器';
  fallback.append(brand, status);
  var frame = document.createElement('iframe');
  frame.className = 'hertz-startup-frame';
  frame.title = 'Hertz Studio 开屏动画与加载进度';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  overlay.append(fallback, frame);

  function lockContent(element) {
    if (element === overlay || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(element.tagName)) return;
    if (!inertElements.has(element)) inertElements.set(element, element.inert);
    element.inert = true;
  }
  var observer = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) lockContent(node);
      });
    });
  });

  function dismiss(immediate) {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(watchdog);
    observer.disconnect();
    window.removeEventListener('message', onSplashMessage);
    inertElements.forEach(function (wasInert, element) { element.inert = wasInert; });
    inertElements.clear();
    var hadFocus = overlay.contains(document.activeElement);
    overlay.classList.add('is-exiting');
    if (hadFocus) {
      var tabIndex = document.body.getAttribute('tabindex');
      document.body.tabIndex = -1;
      document.body.focus({ preventScroll: true });
      if (tabIndex === null) document.body.removeAttribute('tabindex');
      else document.body.setAttribute('tabindex', tabIndex);
    }
    if (immediate || reducedMotion) overlay.remove();
    else window.setTimeout(function () { overlay.remove(); }, 420);
  }

  function release(reason) {
    if (released) return;
    released = true;
    outcome = reason;
    if (attached) clearTimeout(watchdog);
    publish();
    if (attached) send('ready');
    // A missing or blocked splash must not hide a usable player.
    if (!attached && (frameSettled || reason !== 'ready')) dismiss();
  }

  function checkReady() {
    if (!appReady || released) return;
    var pending = Array.from(tasks.values()).some(function (task) { return task.state === 'loading'; });
    if (!pending) release('ready');
  }

  function publish() {
    if (dismissed) return;
    var values = Array.from(tasks.values());
    var settled = values.filter(function (task) {
      return task.state === 'settled' || task.state === 'failed' || task.state === 'skipped';
    }).length;
    var loading = values.find(function (task) { return task.state === 'loading' && task !== tasks.get('app'); });
    var text = released
      ? outcome === 'timeout' ? '部分内容将在进入后继续加载' : '正在打开播放器'
      : loading ? '正在准备' + loading.label : '正在启动播放器';
    status.textContent = text;
    if (attached) send('progress', { value: settled / values.length, status: text });
  }

  // Brand status is the only cross-frame payload. Source identity is checked on
  // receipt; '*' also supports DBX frames whose sandbox gives them a null origin.
  function send(type, payload) {
    frame.contentWindow.postMessage(Object.assign({ type: 'hertz-splash:' + type }, payload), '*');
  }
  function onSplashMessage(event) {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'hertz-splash:attached') {
      if (dismissed || attached) return;
      attached = true;
      overlay.classList.add('is-attached');
      status.removeAttribute('role');
      fallback.setAttribute('aria-hidden', 'true');
      frame.removeAttribute('aria-hidden');
      frame.removeAttribute('tabindex');
      publish();
      if (released) { clearTimeout(watchdog); send('ready'); }
    } else if (event.data.type === 'hertz-splash:exit') dismiss();
  }
  window.addEventListener('message', onSplashMessage);

  window.HertzStartup = {
    track: function (name, promise) {
      var task = tasks.get(name);
      if (!task || released || dismissed) return promise;
      task.state = 'loading';
      publish();
      Promise.resolve(promise).then(function () {
        task.state = 'settled';
        publish();
        checkReady();
      }, function () {
        task.state = 'failed';
        publish();
        checkReady();
      });
      return promise;
    },
    ready: function () {
      if (dismissed) return;
      appReady = true;
      tasks.get('app').state = 'settled';
      tasks.forEach(function (task) { if (task.state === 'waiting') task.state = 'skipped'; });
      publish();
      checkReady();
    },
    fail: function () { release('failed'); dismiss(true); },
    disable: function () { release('disabled'); dismiss(true); },
    get state() {
      return {
        outcome: outcome,
        appReady: appReady,
        dismissed: dismissed,
        tasks: Array.from(tasks, function (entry) { return { name: entry[0], state: entry[1].state }; }),
      };
    },
  };

  function frameLoaded() {
    frameSettled = true;
    // Let the document's queued message handshake arrive before treating an
    // otherwise completed load as a missing or blocked animation script.
    window.setTimeout(function () { if (released && !attached) dismiss(); }, 0);
  }
  frame.addEventListener('load', frameLoaded, { once: true });
  frame.addEventListener('error', frameLoaded, { once: true });

  var scriptUrl = document.currentScript.src;
  var splashUrl = new URL('splash/hertzstudio-splash.html', scriptUrl);
  splashUrl.searchParams.set('host', '1');
  // Preserve the embedded asset fingerprint so a new build never reuses an old
  // splash while the parent loads the new startup controller.
  var version = new URL(scriptUrl).searchParams.get('v');
  if (version) splashUrl.searchParams.set('v', version);
  // Set the real navigation before attaching the iframe. Otherwise the initial
  // about:blank load can incorrectly mark a still-loading splash as unavailable.
  frame.src = splashUrl.href;
  document.body.appendChild(overlay);
  Array.from(document.body.children).forEach(lockContent);
  observer.observe(document.body, { childList: true });
  watchdog = window.setTimeout(function () {
    if (released && !attached) dismiss();
    else release('timeout');
  }, MAX_WAIT);
})();
