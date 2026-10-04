// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 自建 prompt / confirm。
//
// DBX 的插件 iframe 只有 sandbox="allow-scripts"，没有 allow-modals：调
// window.prompt / confirm / alert 会被浏览器直接忽略（分别返回 null / false），
// 不报错也不弹窗。歌单重命名、删除确认、曲目信息编辑这些流程于是静默失效——
// 症状是"点了没反应"，比抛错难查得多。
//
// 独立形态下原生弹窗一切正常，所以那边原样委托给 window.prompt / window.confirm，
// 行为与改动前逐字节一致；只有插件形态才走这套自建模态。
//
// 视觉复用现成的 .np-modal / .np-card / .btn，不另起一套设计语言。

(function () {
  'use strict';

  var useNative = !(window.hertzHost && window.hertzHost.isDbx);

  // 同一时刻只允许一个模态。调用点可能在一次交互里连着问好几个字段
  // （曲目信息编辑就是标题/歌手/专辑三连问），排队才不会互相盖掉。
  var queue = Promise.resolve();

  function enqueue(task) {
    var result = queue.then(task, task);
    queue = result.then(function () {}, function () {});
    return result;
  }

  /// 弹一个模态。resolve 成原生语义：prompt → string|null，confirm → boolean。
  function showModal(options) {
    return new Promise(function (resolve) {
      var wantsInput = !!options.input;

      var backdrop = document.createElement('div');
      backdrop.className = 'np-modal';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className = 'np-card';

      var head = document.createElement('header');
      head.className = 'np-head';
      var headText = document.createElement('div');
      headText.className = 'np-head-text';
      var title = document.createElement('div');
      title.className = 'np-title';
      title.textContent = wantsInput ? '请输入' : '请确认';
      headText.appendChild(title);
      head.appendChild(headText);
      card.appendChild(head);

      var message = document.createElement('p');
      message.className = 'hz-dialog-msg';
      message.textContent = options.message;
      card.appendChild(message);

      var input = null;
      if (wantsInput) {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'hz-dialog-input';
        input.value = options.defaultValue == null ? '' : String(options.defaultValue);
        card.appendChild(input);
      }

      var actions = document.createElement('div');
      actions.className = 'hz-dialog-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = '取消';
      var submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn primary';
      submit.textContent = wantsInput ? '确定' : '确认';
      actions.append(cancel, submit);
      card.appendChild(actions);

      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      var cancelValue = wantsInput ? null : false;

      function finish(value) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(value);
      }
      // 捕获阶段拦截并阻断传播：舞台、全屏、弹窗各自都绑了 Escape，
      // 让它们也收到会把对话框之外的东西一起关掉。
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(cancelValue);
        } else if (event.key === 'Enter' && wantsInput) {
          event.preventDefault();
          finish(input.value);
        }
      }
      document.addEventListener('keydown', onKey, true);

      cancel.onclick = function () { finish(cancelValue); };
      submit.onclick = function () { finish(wantsInput ? input.value : true); };
      backdrop.onclick = function (event) {
        if (event.target === backdrop) finish(cancelValue);
      };

      if (input) { input.focus(); input.select(); } else { submit.focus(); }
    });
  }

  window.hertzDialog = {
    /// 等价于 window.prompt：取消返回 null，确定返回输入的字符串（可能是空串）。
    prompt: function (message, defaultValue) {
      if (useNative) return Promise.resolve(window.prompt(message, defaultValue));
      return enqueue(function () {
        return showModal({ message: message, defaultValue: defaultValue, input: true });
      });
    },
    /// 等价于 window.confirm。
    confirm: function (message) {
      if (useNative) return Promise.resolve(window.confirm(message));
      return enqueue(function () { return showModal({ message: message, input: false }); });
    },
    /// 契约脚本用：当前是否会走自建模态。
    usesCustomModals: function () { return !useNative; },
  };
})();
