// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 舞台背景的共享 WebGL 宿主：一块画布、一个上下文。
//
// 为什么需要它：部分运行环境（如某些 Electron / GPU 驱动）只允许页面同时
// 存在一个 WebGL 上下文。粒子专辑封面与星河各自创建上下文会导致后初始化
// 的那个静默失败。GL 程序、缓冲、纹理本就可以在同一个上下文里共存，所以
// 这里先把上下文建好，stage-cover-particles.js / stage-starriver.js 都往
// 这同一个上下文里注册自己的资源，按场景各自绘制。
//
// 本模块必须排在两个场景模块之前加载。WebGL 不可用时上下文为 null，
// 两个场景模块会放弃初始化，由 CSS 旋转封面兜底。

(function () {
  'use strict';

  var coverEl = null;
  var canvas = null;
  var gl = null;

  function init() {
    if (canvas) return api;
    if (!window.Stage) return null;
    coverEl = document.querySelector('.lp-cover');
    if (!coverEl) return null;

    canvas = document.createElement('canvas');
    canvas.className = 'lp-cover-gl';
    canvas.setAttribute('aria-hidden', 'true');
    coverEl.appendChild(canvas);

    var context = null;
    try {
      context = canvas.getContext('webgl2', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: 'high-performance'
      }) || canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: 'high-performance'
      });
    } catch (e) { context = null; }

    if (!context) {
      // 拿不到上下文：移除画布，让 CSS 封面继续工作
      coverEl.removeChild(canvas);
      canvas = null;
      gl = null;
      return null;
    }
    gl = context;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    return api;
  }

  // 销毁：移除画布、释放引用（WebGL 上下文随 canvas 被回收）
  function destroy() {
    if (canvas && coverEl && canvas.parentNode) {
      try { coverEl.removeChild(canvas); } catch (e) { /* ignore */ }
    }
    canvas = null;
    gl = null;
    coverEl = null;
  }

  var api = {
    init: init,
    destroy: destroy,
    canvas: function () { return canvas; },
    gl: function () { return gl; }
  };

  window.StageGLHost = api;
})();
