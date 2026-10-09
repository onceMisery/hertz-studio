// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 皮肤：chaoxi（潮汐）—— 播放面板的展开/收起
// --------------------------------------------------------------------------
// 这套皮肤只做一件事：**把播放面板从常驻的右侧栏改成按需浮出的浮层**。
// 前两版把它做成常驻栏，宽度直接从内容区里扣（1440 屏上内容只剩 846），
// 骨架仍是"三栏工作台" —— 用户反馈"基本没啥变化"就来自这里。
// 现在内容区拿回全宽，播放面板默认收起，需要时点右下角那颗把手浮出。
//
// 为什么必须写 JS 而不是纯 CSS：展开/收起是一个**用户动作**，
// 而皮肤 CSS 有一条纪律 —— 不许写交互状态选择器（:hover/:active/:focus），
// 状态语义由 style.css 全站统一（见 skin.chaoxi.css 文件头）。
// 于是"点一下展开"这件事只能由皮肤的生命周期来做，
// CSS 只负责两个状态各自的几何。
//
// 生命周期的规矩（与 liunian/qingfeng 同一套）：
//   · mount 里造出来的节点，unmount 必须摘干净 —— 漏一个就是
//     "切走皮肤后屏幕上多一颗按钮"，而且它还会继续响应点击。
//   · 挂 body 而不是 .topbar / .bar：那两块各自形成层叠上下文，
//     留在里面压不过 body 层里的浮层（项目里所有弹层都是同一个理由）。
//   · localStorage 里的是**用户的选择**，不是临时状态，unmount 不删 ——
//     切走再切回来，面板该是开着还是开着。

(function () {
  'use strict';

  var SKIN_ID = 'chaoxi';
  var KEY = 'vmusic.chaoxi.stage';
  var OPEN_CLASS = 'chaoxi-stage-open';
  var HANDLE_ID = 'chaoxi-stage-handle';

  var handle = null;
  var mounted = false;

  function make(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function readStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function writeStored(value) {
    try { localStorage.setItem(KEY, value); } catch (e) { /* 隐私模式 */ }
  }

  /// 只管两个状态的标记，几何全在 CSS 里。
  function setOpen(open) {
    document.body.classList.toggle(OPEN_CLASS, !!open);
    if (!handle) return;
    handle.setAttribute('aria-expanded', open ? 'true' : 'false');
    handle.title = open ? '收起播放面板' : '展开播放面板';
    handle.setAttribute('aria-label', handle.title);
  }

  function buildHandle() {
    var node = make('button', 'chaoxi-handle');
    node.type = 'button';
    node.id = HANDLE_ID;
    // 图标用一个音符字符而不是 svg：这颗把手是皮肤自造的，
    // 往共享 sprite 里塞一个只在这里用的 symbol 不划算。
    var icon = make('span', 'chaoxi-handle-icon');
    icon.textContent = '♪';
    icon.setAttribute('aria-hidden', 'true');
    var text = make('span', 'chaoxi-handle-text');
    text.textContent = '播放';
    node.appendChild(icon);
    node.appendChild(text);
    node.onclick = function () {
      setOpen(!document.body.classList.contains(OPEN_CLASS));
      writeStored(document.body.classList.contains(OPEN_CLASS) ? 'open' : 'closed');
    };
    return node;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    handle = buildHandle();
    // 挂 body：留在 .topbar / .bar 里会落进它们的层叠上下文。
    document.body.appendChild(handle);
    setOpen(readStored() === 'open');
  }

  function unmount() {
    // 顺序有讲究：先摘状态类，再摘节点。反过来的话，摘节点的那一帧
    // body 上还留着 OPEN_CLASS，CSS 会对着一个已经不在的元素算样式。
    document.body.classList.remove(OPEN_CLASS);
    if (handle && handle.parentNode) handle.parentNode.removeChild(handle);
    handle = null;
    mounted = false;
    // 故意不删 localStorage：那是用户的选择。
  }

  window.Skins.registerLifecycle(SKIN_ID, { mount: mount, unmount: unmount });

  // 暴露仅用于排障/契约脚本。
  window.__chaoxiSkin = {
    isMounted: function () { return mounted; },
    isOpen: function () { return document.body.classList.contains(OPEN_CLASS); }
  };
})();
