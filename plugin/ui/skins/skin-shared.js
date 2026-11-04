// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 界面皮肤共用的低层工具（零依赖 IIFE）。
//
// 收敛的是**逐字等价**的两段：
//   · 封面位图回填（applyImg）：插件形态下远程地址经 sidecar 换成 data URL；
//   · 自建节点登记（make/remove）：卸载时统一拆掉本皮肤新建的结构节点。
//
// 节点搬运（原 relocate/restore 锚点控制器）已于 R4 退役：壳层 chrome 与业务
// 根的迁移统一走外壳声明式装配（HertzShell.assembleLayout / attachView，设计
// §7.1/§7.2），外壳记录原位并严格逆还原，皮肤不再自持锚点与还原账本。
//
// 加载约定与其它前端模块一致：全局命名空间 + <script defer> 顺序加载，
// 本文件必须排在各 skin.<id>.js 之前。

(function () {
  'use strict';

  /// <img> 位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画
  /// 不出 https 图）。HertzCovers 由 app.js 挂出；独立形态/契约检查沙箱拿不到时
  /// 回落成直接赋值，即独立形态的同款行为。
  function applyImg(img, url) {
    if (window.HertzCovers) { window.HertzCovers.applyImg(img, url); return; }
    if (!img) return;
    if (url) img.src = url;
    else img.removeAttribute('src');
  }

  /// 自建节点登记：make 建的节点在卸载时统一 remove。
  function createBuilt() {
    var built = [];   // 本皮肤新建的节点

    function make(tag, cls, parent) {
      var n = document.createElement(tag || 'div');
      if (cls) n.className = cls;
      if (parent) parent.appendChild(n);
      built.push(n);
      return n;
    }

    function remove() {
      built.forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      built = [];
    }

    return { make: make, remove: remove };
  }

  window.SkinShared = {
    applyImg: applyImg,
    createBuilt: createBuilt,
  };
})();
