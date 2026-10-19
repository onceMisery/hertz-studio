// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Shared page admission for search reads. Cancellation invalidates a session
// immediately, but an uncancellable DBX invoke keeps its slot until it settles.
(function (global) {
  'use strict';
  var LIMIT = 2, QUEUE_LIMIT = 64, active = [], queue = [], serial = 0;
  function aborted() { var e = new Error('搜索已取消'); e.name = 'AbortError'; return e; }
  function busy() { var e = new Error('搜索通道繁忙，请稍后重试'); e.code = 'search_busy'; e.status = 429; return e; }
  function pump() {
    while (active.length < LIMIT) {
      var index = queue.findIndex(function (task) {
        return !active.some(function (running) { return running.source === task.source; });
      });
      if (index < 0) return;
      var task = queue.splice(index, 1)[0];
      active.push(task);
      start(task);
    }
  }
  function start(task) {
    Promise.resolve().then(function () {
      if (!task.session.active) throw aborted();
      return task.transport.get(task.path, {
        signal: task.controller ? task.controller.signal : undefined,
        waitForSettlement: true, retry: false,
      });
    }).then(task.resolve, task.reject).finally(function () {
      active.splice(active.indexOf(task), 1);
      pump();
    });
  }
  function create(transport) {
    var session = { queryId: ++serial, active: true };
    session.get = function (path) {
      if (!session.active) return Promise.reject(aborted());
      if (queue.length >= QUEUE_LIMIT) return Promise.reject(busy());
      var query = path.split('?')[1] || '';
      var source = new URLSearchParams(query).get('source') || 'local';
      return new Promise(function (resolve, reject) {
        queue.push({ session: session, path: path, source: source, transport: transport,
          controller: typeof AbortController === 'function' ? new AbortController() : null,
          resolve: resolve, reject: reject });
        pump();
      });
    };
    session.cancel = function () {
      if (!session.active) return;
      session.active = false;
      queue = queue.filter(function (task) {
        if (task.session !== session) return true;
        task.reject(aborted()); return false;
      });
      active.forEach(function (task) {
        if (task.session !== session) return;
        task.reject(aborted());
        if (task.controller) task.controller.abort();
      });
      pump();
    };
    return session;
  }
  function failure(error) {
    var code = error && error.code || '';
    var status = error && error.status;
    var retryable = !(error && error.name === 'AbortError') && status !== 401 && status !== 403 && status !== 404
      && !/config|credential|disabled|unsupported/.test(code);
    var label = status === 401 ? '需要登录' : status === 403 ? '无权访问'
      : /config|credential|disabled|unsupported/.test(code) || status === 404 ? '当前音源未就绪'
        : status === 429 ? '请求过于频繁' : status === 504 || /timeout/.test(code) ? '搜索超时'
          : code === 'upstream_rejected' ? '音源拒绝了搜索请求'
            : code === 'upstream_error' || (error && error.name === 'TypeError') ? '音源连接失败，请检查网络'
              : '搜索暂不可用';
    return { code: code, requestId: error && error.requestId || '', retryable: retryable, label: label };
  }
  global.HertzSearch = { create: create, failure: failure };
}(window));
