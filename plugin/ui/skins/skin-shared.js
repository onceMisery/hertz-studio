// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 界面皮肤：liunian / qingfeng 两套「DOM 重编排层」共用的低层工具（零依赖 IIFE）。
//
// 这两套皮肤各自维护一份近乎相同的骨架，这里把其中**逐字等价**的三段收敛到一处：
//   · 封面位图回填（applyImg）：插件形态下远程地址经 sidecar 换成 data URL；
//   · 节点搬运控制器（relocate/restore）：原位留锚点、LIFO 还原原顺序；
//   · 自建节点登记（make/remove）：卸载时统一拆掉本皮肤新建的结构节点。
//
// 每套皮肤实例化自己的控制器（锚点类名与标记属性由皮肤传入），因此对外行为、
// 类名、DOM 结构、事件语义与收敛前完全一致。
//
// 加载约定与其它前端模块一致：全局命名空间 + <script defer> 顺序加载，
// 本文件必须排在 skin.liunian.js / skin.qingfeng.js 之前。

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

  /// 锚点搬运控制器：每个皮肤一份实例。
  ///
  /// anchorClass / anchorAttr 决定原位锚点长什么样（流年是
  /// `<span class="ln-anchor" data-ln="1">`，清风是 `qf-anchor` / `data-qf`）。
  /// 语义与两皮肤原先各自的实现一一等价：搬运时在 node 原位插入锚点，还原时
  /// 按后进先出（被包裹进新节点的内层先还原到锚点，锚点在原容器，顺序天然安全）
  /// 插回锚点位置再删掉锚点。
  function createMoves(anchorClass, anchorAttr) {
    var moves = [];   // { node, anchor }：搬运记录，后进先出地还原

    function relocate(node, parent, before) {
      if (!node || !parent) return node || null;
      var anchor = document.createElement('span');
      anchor.className = anchorClass;
      anchor.setAttribute(anchorAttr, '1');
      node.parentNode.insertBefore(anchor, node);
      if (before) parent.insertBefore(node, before);
      else parent.appendChild(node);
      moves.push({ node: node, anchor: anchor });
      return node;
    }

    function restore() {
      for (var i = moves.length - 1; i >= 0; i -= 1) {
        var m = moves[i];
        if (m.anchor.parentNode) m.anchor.parentNode.insertBefore(m.node, m.anchor);
        if (m.anchor.parentNode) m.anchor.remove();
      }
      moves = [];
    }

    return { relocate: relocate, restore: restore };
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
    createMoves: createMoves,
    createBuilt: createBuilt,
  };
})();