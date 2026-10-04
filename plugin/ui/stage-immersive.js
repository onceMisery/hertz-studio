// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 全屏舞台统一入口。
//
// 此前这里有两套全屏：#lyric-page 的原生全屏 + 六场景玻璃坞（创意舞台），
// 与 stage3d 的沉浸式三维舞台并存——两个 fixed 层抢 F 键/指针/焦点，两套
// 场景坞语义重复（tunnel/terrain/orb 两边同名），两个 WebGL 上下文抢资源。
// 现统一为：所有「全屏舞台 / 全屏演出」入口（#stage-fs、#lp-fs、F 键）一律
// 开往沉浸声场（Stage3D），原生全屏申请也由 Stage3D 接管（requestFullscreen
// 导出接口）；歌词演出页只承担歌词排版，不再进入原生全屏；场景切换交给
// Stage3D 自带的 1-7 舞台坞，玻璃坞连同它的场景清单一起退役。
//
// 键位分工：Stage3D 打开时，它的 document 捕获监听先吃掉 F/Esc/V（见
// stage3d.js onKeyDown），这里的全局 F 只在它关闭时生效——一次按键只有
// 一个写者。
//
// 零依赖、ES5、无构建。本模块不持有任何渲染逻辑。

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function enter() {
    if (!window.Stage3D || !Stage3D.open) return;
    Stage3D.open();
    // .s3d 常驻 DOM（class 控制显隐），open 返回即已可见；个别浏览器要求
    // 全屏元素此刻处于可见状态，推一拍再申请。
    setTimeout(function () {
      if (Stage3D.requestFullscreen) Stage3D.requestFullscreen();
    }, 40);
  }

  function toggle() {
    // 开着时 Stage3D 自己的 F 处理器负责原生全屏切换，这里不再插手。
    if (window.Stage3D && Stage3D.isActive && Stage3D.isActive()) return;
    enter();
  }

  function isTypingTarget(t) {
    var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      !!(t && t.isContentEditable);
  }

  // 只初始化一次：绑的是单向监听，没有解绑路径；重复进来会「点一次跑两次」。
  var inited = false;

  function init() {
    if (inited) return;
    inited = true;

    var fsBtn = $('lp-fs');
    if (fsBtn) fsBtn.addEventListener('click', enter);
    var sideBtn = $('stage-fs');
    if (sideBtn) sideBtn.addEventListener('click', enter);

    // F 全局切换全屏舞台（输入框里打字不响应；不和修饰键组合冲突）。
    document.addEventListener('keydown', function (e) {
      if (!(e.key === 'f' || e.key === 'F')) return;
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      toggle();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
