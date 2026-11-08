// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 「动画绘景」SVG 舞台适配层。职责边界：绘景资产（art*.svg 字符串与 cx-* 关键帧）
// 全部来自 creative-anime.js 注册进 CreativeGL 的 presentation.art，本文件不持有
// 任何画稿；只负责 hertz-studio 集成 —— 挂载/卸载、镜像复制、音频呼吸、
// 减弱动效、离屏暂停、帧门降档。
//
// 与 GLSL 舞台（anime-coast 等着色器场景）的关系：同一批画稿的两种渲染。SVG 这份
// 换来与工坊卡片逐像素同源、镜像只是一个 transform、且不依赖 WebGL2 —— 本身就
// 是 GL 不可用时的降级路径；代价是相机视差与 audio uniform（v1 用一层呼吸辉光
// 兜底音频响应）。
//
// Stage3D 的调用面：
//   StageAnimeSvg.available()          入口置灰判断（注册表里有动画绘景场景）
//   StageAnimeSvg.setHost(el|null)     挂进宿主层 / 卸载；返回是否成功
//   StageAnimeSvg.setPrefs(p)          { scene, mirror } 即时生效
//   StageAnimeSvg.degradedBecause()    最近一次挂载失败的原因，null 为可用
(function () {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }

  var DEFAULT_SCENE = 'anime-coast';
  var probeCache = null;
  var reason = null;
  var host = null;
  var mounted = false;
  var raf = 0;
  var lastTick = 0;
  var lastLevel = -1;
  var artSeq = 0;
  var mountUsedStatic = false;
  var prefs = { scene: DEFAULT_SCENE, mirror: false };
  var ZEROS = new Float32Array(64);

  // onset.js 以 defer 先于本文件加载，这里一定拿得到；兜底桩保证缺依赖时
  // 也只是没有音频反应，而不是每帧抛错。
  var onset = window.Onset
    ? window.Onset.create({})
    : { step: function () {}, bins: ZEROS, energy: 0, pulse: 0, onBeat: function () {} };

  function reduced() {
    return !!(window.Stage && Stage.presentation && Stage.presentation().reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // 注册表是画稿的唯一来源：工坊卡片与舞台挂同一份字符串，两边才可能逐像素一致。
  function sceneDef(id) {
    var GL = window.CreativeGL;
    if (!GL || !GL.sceneById) return null;
    var def = GL.sceneById(id);
    if (!def || !def.presentation || def.presentation.family !== 'anime' || !def.presentation.art) return null;
    return def;
  }

  function available() {
    if (probeCache === null) {
      var GL = window.CreativeGL;
      probeCache = !!(GL && GL.scenes && GL.scenes().some(function (s) {
        return s.presentation && s.presentation.family === 'anime' && s.presentation.art;
      }));
    }
    return probeCache;
  }

  function degradedBecause() { return reason; }

  // 同文档会同时存在工坊卡片的同一份 SVG（渐变/路径 ID 相同），url(#…) 按文档序
  // 解析到第一份 —— 卡片重渲染时舞台这份的填充会丢。每次挂载换一套实例前缀。
  // 画稿里的 ID 全部带 cx- 前缀，替换范围因此收敛，不会误伤路径数据。
  // artStatic 是后续迁移的静态画稿；当前只有动态一份时，静态态由 CSS 的
  // animation:none 兜底（与工坊卡片同一条规则）。
  function instanceArt(id, tag) {
    var def = sceneDef(id);
    if (!def) return null;
    var present = def.presentation;
    var art = present.artStatic && reduced() ? present.artStatic : present.art;
    mountUsedStatic = !!(present.artStatic && reduced());
    var prefix = 's3da' + tag + (++artSeq) + '-';
    return art
      .replace(/id="(cx-[^"]+)"/g, 'id="' + prefix + '$1"')
      .replace(/url\(#(cx-[^"]+)\)/g, 'url(#' + prefix + '$1)')
      .replace(/href="#(cx-[^"]+)"/g, 'href="#' + prefix + '$1"')
      // 640×400 画稿以完整构图居中（xMidYMid meet）：舞台看到的与小图（工坊卡片）
      // 是同一帧，letterbox 用舞台暗底托裱。曾经用 slice 铺满——那会按舞台比例
      // 裁掉画稿上下或两侧，"和小图不一致"就是这么来的。
      .replace('viewBox="0 0 640 400"', 'viewBox="0 0 640 400" preserveAspectRatio="xMidYMid meet"');
  }

  function nodeFrom(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.firstElementChild;
  }

  function mountInto(el) {
    var primary = instanceArt(prefs.scene, 'p');
    if (!primary) {
      reason = '未找到绘景作品「' + prefs.scene + '」，请更换作品或回到沉浸声场';
      return false;
    }
    reason = null;
    el.textContent = '';
    el.appendChild(nodeFrom(primary));
    // 镜像对称：同一份画稿再挂一份，CSS 加 scaleX(-1) —— 左右两侧逐像素一致，
    // 且两份动画同相位，对称关系随时间保持。
    if (prefs.mirror) {
      var copy = instanceArt(prefs.scene, 'm');
      var node = copy && nodeFrom(copy);
      if (node) {
        node.classList.add('s3d-anime-mirror');
        el.appendChild(node);
      }
    }
    el.dataset.motion = 'running';
    lastLevel = -1;
    return true;
  }

  // 每帧：读频谱 → 起音 → 写宿主 CSS 变量。迟滞 0.02 以上才落笔，避免无谓的
  // 样式重算；呼吸辉光本身是纯 opacity 合成，不吃主线程。
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!mounted || !host) return;
    var dt = lastTick ? Math.min(now - lastTick, 100) : 16;
    lastTick = now;
    var spectrum = (window.Stage && Stage.spectrum && Stage.spectrum()) || null;
    // 静音/暂停时喂零谱，让能量自然回落到环境基线，而不是停在旧值。
    onset.step(dt, spectrum && spectrum.length ? spectrum : ZEROS, now);
    var level = Math.min(1, onset.energy * 1.6);
    if (Math.abs(level - lastLevel) >= 0.02) {
      lastLevel = level;
      host.style.setProperty('--s3d-anime-audio', level.toFixed(3));
    }
  }

  function setHost(el) {
    if (el === host) return !el || mounted;
    var previous = host;
    host = el;
    if (!el) {
      if (mounted) {
        cancelAnimationFrame(raf);
        raf = 0;
        mounted = false;
      }
      // 与 StageCoast 摘 canvas 同构：卸载即清场，不留一屏隐藏的动画节点。
      if (previous) previous.textContent = '';
      reason = null;
      return true;
    }
    if (!available()) {
      reason = '动画绘景模块未加载（需要创意编排注册表）';
      return false;
    }
    if (!mountInto(el)) return false;
    mounted = true;
    if (!raf) {
      lastTick = 0;
      raf = requestAnimationFrame(tick);
    }
    return true;
  }

  function setPrefs(p) {
    if (!p) return;
    var sceneChanged = typeof p.scene === 'string' && p.scene !== prefs.scene;
    var mirrorChanged = typeof p.mirror === 'boolean' && p.mirror !== prefs.mirror;
    if (sceneChanged) prefs.scene = p.scene;
    if (mirrorChanged) prefs.mirror = p.mirror;
    if (!mounted || !host) return;
    // 换画/换对称才重建；偏好没变时也要重新核对静态画稿（减弱动效可能刚被打开）。
    var def = sceneDef(prefs.scene);
    var wantStatic = !!(def && def.presentation.artStatic && reduced());
    if (sceneChanged || mirrorChanged || wantStatic !== mountUsedStatic) {
      mounted = mountInto(host);
    }
  }

  // 标签页隐藏时停掉动画：与工坊的离屏暂停同一目的，只是舞台没有观察器，
  // 挂载期间 visibilitychange 就够。
  document.addEventListener('visibilitychange', function () {
    if (!mounted || !host) return;
    host.dataset.motion = documentHidden() ? 'paused' : 'running';
  });

  // 帧门测得吃不住（lowfx）就摘掉音频呼吸辉光 —— transform/opacity 主层本来就
  // 便宜，唯一可让的是这层全屏 opacity 合成。只降不升。
  document.addEventListener('stage:fps', function (e) {
    if (!e.detail || !e.detail.lowfx || !host) return;
    host.classList.add('s3d-anime-lowfx');
  });

  window.StageAnimeSvg = {
    available: available,
    setHost: setHost,
    setPrefs: setPrefs,
    degradedBecause: degradedBecause
  };
}());
