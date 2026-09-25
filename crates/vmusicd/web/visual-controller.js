// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// VisualController —— 视觉子系统的统一控制器。
//
// 此前各视觉模块（舞台主循环 / 粒子 / GL 宿主 / 粒子封面 / 星河）由
// app.js 的 initStage 按硬编码顺序逐个 new，配置入口分散、且没有任何
// 模块能被销毁（GL 资源只增不减）。本模块集中三件事：
//
//   init()          按依赖顺序初始化全部视觉模块
//   update(config)  统一配置入口（模式 / 场景 / 控制舱参数）
//   destroy()       逆序销毁，释放各模块持有的 GL/DOM 资源
//
// 每个模块可选实现标准接口 init / destroy；缺失时跳过，
// 控制器本身不直接碰渲染逻辑。

(function () {
  'use strict';

  // 初始化顺序即依赖顺序：Stage 主循环 → 2D 粒子 → GL 宿主 →
  // 两个 GL 场景（封面粒子、星河）。
  var MODULES = [
    {
      name: 'stage',
      get: function () { return window.Stage; },
    },
    {
      name: 'particles',
      get: function () { return window.StageParticles; },
    },
    {
      name: 'glhost',
      get: function () { return window.StageGLHost; },
    },
    {
      name: 'coverparticles',
      get: function () { return window.StageCoverParticles; },
    },
    {
      name: 'starriver',
      get: function () { return window.StageStarRiver; },
    },
    {
      // 沉浸式三维舞台。它自己建上下文、自己走 Stage.gate()，这里只负责
      // 让它的生命周期跟着其余视觉层一起走（逆序销毁）。
      name: 'stage3d',
      get: function () { return window.Stage3D; },
    },
  ];

  var ready = false;
  var started = [];

  function init() {
    if (ready) return api;
    for (var i = 0; i < MODULES.length; i += 1) {
      var mod = MODULES[i].get();
      if (!mod) continue;
      // 任何模块初始化失败都不拖垮整体：其余视觉层照常工作，
      // 失败方由各自的降级路径兜底。
      try {
        if (typeof mod.init === 'function') mod.init();
        started.push(MODULES[i]);
      } catch (e) {
        console.warn('视觉模块初始化失败：' + MODULES[i].name, e);
      }
    }
    ready = true;
    return api;
  }

  // 统一配置更新。支持：
  //   { mode: 'karaoke' }             歌词模式
  //   { scene: 'starriver' }          背景场景
  //   { control: { density: 120 } }   舞台控制舱参数
  function update(config) {
    if (!config || !window.Stage) return api;
    if (config.mode && typeof Stage.setMode === 'function') {
      Stage.setMode(config.mode);
    }
    if (config.scene && typeof Stage.setScene === 'function') {
      Stage.setScene(config.scene);
    }
    if (config.control && window.StageControl && typeof StageControl.set === 'function') {
      StageControl.set(config.control);
    }
    return api;
  }

  // 逆序销毁：后初始化的模块先释放
  function destroy() {
    for (var i = started.length - 1; i >= 0; i -= 1) {
      var spec = started[i];
      var mod = spec.get();
      if (!mod || typeof mod.destroy !== 'function') continue;
      try { mod.destroy(); } catch (e) {
        console.warn('视觉模块销毁失败：' + spec.name, e);
      }
    }
    started = [];
    ready = false;
    return api;
  }

  function isReady() { return ready; }

  var api = {
    init: init,
    update: update,
    destroy: destroy,
    isReady: isReady,
  };

  window.VisualController = api;
})();
