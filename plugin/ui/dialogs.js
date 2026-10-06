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

  /// 弹层焦点管理：把弹层**之外**的内容设为 inert（Tab 进不去、点不动、辅助
  /// 技术跳过），焦点随后交给弹层；返回「收尾」函数，调用后还原背景并把焦点
  /// 还给打开它的那个元素。
  ///
  /// 用 inert 而不是手写 Tab 循环：前者一次堵住 Tab、点击与屏幕阅读器三条路，
  /// 也不用跟页面里动态增删的可聚焦元素赛跑。不支持 inert 的内核退化成「关闭时
  /// 还原焦点」，行为不会更差。
  ///
  /// 约束：`node` 必须是 `document.body` 的直接子节点——背景是靠「把兄弟节点设
  /// 成 inert」实现的，嵌在 .app 内部的弹层盖不住自己的父级。
  function focusScope(node) {
    var opener = document.activeElement;
    var muted = [];
    if ('inert' in HTMLElement.prototype) {
      Array.prototype.forEach.call(document.body.children, function (child) {
        if (child === node || child.contains(node)) return;
        if (child.inert) return;   // 外层弹层已经设过，别记进这次要还原的名单
        child.inert = true;
        muted.push(child);
      });
    }
    return function release() {
      muted.forEach(function (child) { child.inert = false; });
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        try { opener.focus(); } catch (e) { /* 打开它的元素可能已经不可聚焦 */ }
      }
    };
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
      var releaseScope = focusScope(backdrop);

      function finish(value) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        releaseScope();
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

  /// 候选挑选：多行、每行一个下拉。resolve 成 `[{key, value}]`（value 是
  /// 空串表示这一行选了「不采纳」），取消返回 null。
  ///
  /// 原生弹窗没有对应物（`prompt` 只收一个字符串），所以两种形态都走这套
  /// 自建模态——独立形态下用户看到的也是同一块卡片。
  function showPicker(options) {
    return new Promise(function (resolve) {
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
      title.textContent = options.title || '选择匹配';
      headText.appendChild(title);
      head.appendChild(headText);
      card.appendChild(head);

      if (options.message) {
        var message = document.createElement('p');
        message.className = 'hz-dialog-msg';
        message.textContent = options.message;
        card.appendChild(message);
      }

      // 行数可能上百（批量补全），列表自己滚，卡片不动。
      var list = document.createElement('div');
      list.className = 'hz-pick-list';
      list.style.maxHeight = '52vh';
      list.style.overflowY = 'auto';
      var selects = [];
      (options.rows || []).forEach(function (row) {
        var wrap = document.createElement('div');
        wrap.className = 'hz-pick-row';
        var label = document.createElement('div');
        label.className = 'hz-pick-label';
        label.textContent = row.label;
        if (row.sublabel) {
          var sub = document.createElement('div');
          sub.className = 'hz-pick-sub';
          sub.textContent = row.sublabel;
          label.appendChild(sub);
        }
        var select = document.createElement('select');
        select.className = 'hz-pick-select';
        (row.options || []).forEach(function (opt) {
          var option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        });
        if (row.value != null) select.value = row.value;
        wrap.appendChild(label);
        wrap.appendChild(select);
        list.appendChild(wrap);
        selects.push({ key: row.key, el: select });
      });
      card.appendChild(list);

      var actions = document.createElement('div');
      actions.className = 'hz-dialog-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = '取消';
      var submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn primary';
      submit.textContent = options.confirmLabel || '应用';
      actions.append(cancel, submit);
      card.appendChild(actions);

      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      var releaseScope = focusScope(backdrop);

      function finish(value) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        releaseScope();
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }
      document.addEventListener('keydown', onKey, true);

      cancel.onclick = function () { finish(null); };
      submit.onclick = function () {
        finish(selects.map(function (s) { return { key: s.key, value: s.el.value }; }));
      };
      backdrop.onclick = function (event) {
        if (event.target === backdrop) finish(null);
      };
      submit.focus();
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
    /// 弹层焦点管理（inert 背景 + 关闭还焦）。命令面板等自建弹层共用这一套，
    /// 免得每处各写一份 Tab 循环。`node` 必须是 body 的直接子节点，细节见上面
    /// focusScope 的注释。
    focusScope: focusScope,
    /// 候选挑选（在线补全用）。options:
    ///   { title, message, confirmLabel, rows: [{key, label, sublabel, options: [{value, label}], value}] }
    /// 返回 `[{key, value}]`；取消返回 null。
    pick: function (options) {
      return enqueue(function () { return showPicker(options || {}); });
    },
  };
})();
