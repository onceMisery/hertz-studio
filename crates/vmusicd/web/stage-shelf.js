// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 沉浸式三维舞台 · 3D 歌单架（封面流）
//
// 移植自 openmusic 的 GalaxyFloatingSongCard（client/src/components/galaxy/
// GalaxyFloatingSongCard.tsx + lib/galaxyFloatingSongCard.ts）。原项目用
// react-three-fiber 把播放队列画成 three.js 空间里的漂浮封面卡；本项目是
// 零依赖 / ES5 / 无构建的 IIFE，同一套 pose 数学（delta 深度扇出、召唤
// stagger、呼吸、hover 前推、滚轮选曲、点击跳播）改由 CSS 3D 变换承载。
//
// 与 stage3d.js 的边界：
//   · 本模块不碰 WebGL，也不持有播放状态；曲目/进度/频谱全部按帧从
//     Stage.presentation() / Stage.spectrum() 只读拉取；
//   · 切歌、跳播意图只发 'stage:control'（queue-play / toggle），和舞台
//     队列面板走同一条链，不另起播放逻辑；
//   · 容器 .s3d-shelf 与卡片分别 pointer-events:none / auto，空白处的
//     拖拽与滚轮照常穿透给 #s3d-canvas-wrap 的 3D 手势；
//   · 逐帧驱动登记 Stage.gate('stage3d-shelf')，不可见时报 0fps，
//     不另起 requestAnimationFrame。

(function (global) {
  'use strict';

  if (!global) return;

  // ---- openmusic 同款常量（GalaxyFloatingSongCard / galaxyFloatingSongCard）
  var CLICK_THRESHOLD = 10;          // 原 6px，触屏略放宽
  var VISIBLE_RADIUS = 5.5;         // |delta| 超过即不渲染
  var MAX_CARDS = 8;                // 当前曲 + 后续 7 首
  var LERP_CENTER = 0.16;           // 封面流居中平滑
  var LERP_HOVER = 0.14;
  var SUMMON_OPEN_MS = 910;         // shelfSummonOpenDuration
  var SUMMON_CLOSE_MS = 460;        // shelfSummonCloseDuration
  var SUMMON_STAGGER = 0.055;       // 每卡延迟，封顶 0.72s
  var STAGGER_CAP = 0.72;
  var BROWSE_RETURN_MS = 2800;      // 滚轮浏览后无操作自动回到当前曲
  var WHEEL_COOLDOWN_MS = 180;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function fmtDuration(ms) {
    var s = Math.floor(Math.max(0, ms || 0) / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function StageShelf(root) {
    var plane = root.querySelector('#s3d-shelf-plane');
    if (!plane) return null;

    var Stage = global.Stage;

    // ---- 状态
    var items = [];                 // [{id,title,artist,album,duration,cover,playing}]  当前曲在首位
    var nodes = new Map();          // id -> 卡片节点（含 _pose/_spawn 等运行时态）
    var dying = [];                 // 已离队但正在演出退出动画的节点
    var mode = 'side';              // off | stage(横向封面流) | side(右侧竖向)
    var active = false;             // 三维舞台是否开着
    var blocked = false;            // 队列面板 / 设置面板展开
    var center = 0;                 // 平滑中的居中槽位
    var browseIndex = 0;            // 滚轮/滑动浏览的目标槽位（0 = 当前曲）
    var browseAt = 0;
    var lastWheelAt = 0;
    var hoverId = null;
    var pointer = { x: 0, y: 0 };
    var t = 0;
    var bass = 0;
    var inited = false;
    var lastCurrentId = null;
    var lastMetaPct = -1;
    var coverCache = new Map();     // url -> HTMLImageElement（预加载）

    function reducedMotion() {
      var p = Stage && Stage.presentation ? Stage.presentation() : null;
      if (p && p.reduced) return true;
      return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function eco() {
      return !!(Stage && Stage.tier && Stage.tier() === 0);
    }

    function visibleRadius() {
      return eco() ? 3.2 : VISIBLE_RADIUS;
    }

    // ---- 封面预加载：切歌时新卡直接命中缓存，交叉淡化不黑帧
    function preloadCover(url) {
      if (!url || coverCache.has(url)) return;
      var img = new Image();
      img.decoding = 'async';
      coverCache.set(url, img);
      img.src = url;
    }

    // ---- DOM 构建 ---------------------------------------------------------

    function buildNode(item, index) {
      var el = document.createElement('div');
      el.className = 's3d-sc';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '-1');
      el.dataset.id = item.id;
      el.innerHTML =
        '<div class="s3d-sc-sheen" aria-hidden="true"></div>' +
        '<div class="s3d-sc-cover"><img alt="" decoding="async" draggable="false"></div>' +
        '<div class="s3d-sc-body">' +
          '<div class="s3d-sc-tag"></div>' +
          '<div class="s3d-sc-title"></div>' +
          '<div class="s3d-sc-sub"></div>' +
          '<div class="s3d-sc-meta"></div>' +
          '<div class="s3d-sc-progress" aria-hidden="true"><i></i></div>' +
        '</div>' +
        '<div class="s3d-sc-hint" aria-hidden="true">播放</div>';
      paintNode(el, item, index);
      attachCoverLoad(el);
      bindCard(el, item.id);
      el._pose = { hover: 0, reveal: 0, pulse: 0, spawn: 0, dead: 0, dy: 0 };
      plane.appendChild(el);
      return el;
    }

    function setText(el, selector, value) {
      var node = el.querySelector(selector);
      if (node && node.textContent !== value) node.textContent = value;
    }

    // 角标以「当前曲」为锚（队列顺序不会重排，当前曲可能在数组中段）：
    // 后一首标「下一首」，其后标相对序号，之前的标「已播」。
    function tagFor(i, ci) {
      if (i === ci) return '正在播放';
      if (i === ci + 1) return '下一首';
      if (i < ci) return '已播';
      return '队列 +' + (i - ci);
    }

    function paintNode(el, item, index) {
      setText(el, '.s3d-sc-tag', '');
      setText(el, '.s3d-sc-title', item.title || '未知曲目');
      setText(el, '.s3d-sc-sub', item.artist || '未知艺术家');
      setText(el, '.s3d-sc-meta', item.album || (item.duration ? fmtDuration(item.duration) : ''));
      el.classList.toggle('is-current', !!item.playing);
      syncCover(el, item.cover);
    }

    // 只更新文本/角标，绝不在封面 URL 未变时碰 img——队列高频重推时
    // （换曲、增删）已加载的封面不能闪一下再淡入。
    function updateNode(el, item) {
      setText(el, '.s3d-sc-title', item.title || '未知曲目');
      setText(el, '.s3d-sc-sub', item.artist || '未知艺术家');
      el.classList.toggle('is-current', !!item.playing);
      syncCover(el, item.cover);
    }

    function syncCover(el, url) {
      var img = el.querySelector('img');
      if (!url) {
        if (img.dataset.url) {
          img.removeAttribute('src');
          img.dataset.url = '';
          img.classList.remove('is-loaded');
        }
        return;
      }
      preloadCover(url);
      if (img.dataset.url === url) {
        var cached = coverCache.get(url);
        if (cached && cached.complete && cached.naturalWidth > 0) img.classList.add('is-loaded');
        return;
      }
      img.dataset.url = url;
      img.classList.remove('is-loaded');
      img.src = url;
    }

    function repaintTags() {
      var ci = currentIndex();
      items.forEach(function (item, i) {
        var el = nodes.get(item.id);
        if (el) setText(el, '.s3d-sc-tag', tagFor(i, ci));
      });
    }

    // ---- 卡片手势（点击跳播 / 触摸横滑浏览）-------------------------------

    function bindCard(el, id) {
      var down = null;
      var browseBands = 0;

      el.addEventListener('pointerdown', function (e) {
        // 卡片不在画布层内，但仍显式吃掉事件，避免任何上层捕获逻辑误判为拖拽
        e.stopPropagation();
        down = { x: e.clientX, y: e.clientY };
        browseBands = 0;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      });

      el.addEventListener('pointermove', function (e) {
        if (!down) return;
        var band;
        if (mode === 'side') {
          // 右侧竖向架：上下拖动浏览（向下=后续曲目），按卡片高度取带。
          var dy = e.clientY - down.y;
          var step = el.offsetHeight || 96;
          band = dy > 0 ? Math.ceil(dy / step) : Math.floor(dy / step);
        } else {
          // 横向封面流：左右拖动
          var dx = e.clientX - down.x;
          band = dx < 0 ? Math.ceil(-dx / 44) : -Math.floor(dx / 44);
        }
        if (band !== browseBands && band !== 0) {
          nudgeBrowse(band - browseBands);
          browseBands = band;
        }
      });

      function finish(e, cancelled) {
        if (!down) return;
        var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (cancelled || moved > CLICK_THRESHOLD || browseBands !== 0) return;
        onCardTap(id);
      }

      el.addEventListener('pointerup', function (e) { finish(e, false); });
      el.addEventListener('pointercancel', function (e) { finish(e, true); });

      el.addEventListener('mouseenter', function () { hoverId = id; });
      el.addEventListener('mouseleave', function () { if (hoverId === id) hoverId = null; });
    }

    function onCardTap(id) {
      var idx = indexOfId(id);
      if (idx < 0) return;
      if (idx === currentIndex()) {
        document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: 'toggle' } }));
      } else {
        // 不用队列面板的 queue-play：那条链按约束拒绝 online: 虚拟曲目。
        // shelf-play 在 app.js 里分流本地 playTrack / 在线 Online.playAll。
        document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: 'shelf-play', value: id } }));
      }
    }

    function indexOfId(id) {
      for (var i = 0; i < items.length; i += 1) if (items[i].id === id) return i;
      return -1;
    }

    function currentIndex() {
      for (var i = 0; i < items.length; i += 1) if (items[i].playing) return i;
      return 0;
    }

    // ---- 滚轮浏览（在舞台根节点捕获，贴近歌单架区域才截给架子）-------------

    var lastClient = { x: -1, y: -1 };

    function onPointerTrack(e) {
      lastClient.x = e.clientX;
      lastClient.y = e.clientY;
      pointer.x = clamp(e.clientX / Math.max(1, global.innerWidth) * 2 - 1, -1, 1);
      pointer.y = clamp(e.clientY / Math.max(1, global.innerHeight) * 2 - 1, -1, 1);
    }

    function inShelfWheelZone() {
      var vw = global.innerWidth, vh = global.innerHeight;
      var x = lastClient.x, y = lastClient.y;
      if (x < 0) return false;
      if (mode === 'side') {
        // 右侧歌单架竖列带
        return x > vw * 0.70 && y > vh * 0.18 && y < vh * 0.86;
      }
      // stage：底部中央封面流一带（避开底播条与顶部）
      return y > vh * 0.42 && y < vh * 0.80 && Math.abs(x / vw - 0.5) < 0.42;
    }

    function onWheelCapture(e) {
      if (!active || mode === 'off' || blocked || !items.length) return;
      if (!inShelfWheelZone()) return;
      e.preventDefault();
      e.stopPropagation();
      var now = Date.now();
      if (now - lastWheelAt < WHEEL_COOLDOWN_MS) return;
      lastWheelAt = now;
      nudgeBrowse(e.deltaY > 0 ? 1 : -1);
    }

    function nudgeBrowse(dir) {
      // browseIndex 是相对当前曲的偏移（0 = 当前曲），允许向队列两侧浏览
      var ci = currentIndex();
      var maxOffset = items.length - 1 - ci;
      browseIndex = clamp(browseIndex + dir, -ci, maxOffset);
      browseAt = Date.now();
      var targetItem = items[ci + browseIndex];
      var node = targetItem ? nodes.get(targetItem.id) : null;
      if (node) node._pose.pulse = Math.max(node._pose.pulse, 0.55);
      // 暂停态主循环可能已停，滚轮要立刻唤醒封面流滑动。
      if (Stage && Stage.kick) Stage.kick();
    }

    // ---- 数据 --------------------------------------------

    // 以「正在播放」曲为中心取窗口：当前曲永远在列，上下取相邻曲目。
    // 修复：此前直接 slice(0,MAX_CARDS)，播放越过第 8 首后当前曲消失、
    // 歌单架退回队首。对齐 openmusic（current 居首重组）。
    function windowAround(list) {
      var ci = -1;
      for (var k = 0; k < list.length; k += 1) {
        if (list[k] && list[k].playing) { ci = k; break; }
      }
      if (ci < 0) return list.slice(0, MAX_CARDS); // 暂无播放态：退回前 N 条
      // 当前曲 + 后续，占满窗口；前面已播的曲目若窗口有余再补（倒序插前）。
      var after = list.slice(ci, ci + MAX_CARDS);
      var room = MAX_CARDS - after.length;
      if (room > 0) {
        var before = list.slice(Math.max(0, ci - room), ci).reverse();
        // 维持「越远离当前曲越靠外」：已播曲目按距当前曲的距离插到最前
        before.forEach(function (it, bi) {
          after.splice(0, 0, it);
        });
      }
      return after;
    }

    function setItems(list) {
      var source = Array.isArray(list) ? list : [];
      var next = windowAround(source);
      var nextIds = {};
      var now = performance.now();
      var oldIds = {};
      items.forEach(function (it) { oldIds[String(it.id)] = true; });
      next.forEach(function (it) { nextIds[String(it.id)] = true; });

      // 离队卡片交退出动画，不立刻删 DOM（切歌时旧当前曲顺势淡出/滑走）
      items.forEach(function (it) {
        if (nextIds[String(it.id)]) return;
        var el = nodes.get(it.id);
        if (el) {
          el._pose.dead = now;
          dying.push(el);
          nodes.delete(it.id);
        }
      });

      // 新卡建节点；顺序变动只搬序，不重建（封面 img 缓存不闪）
      next.forEach(function (item, i) {
        var el = nodes.get(item.id);
        if (!el) {
          // 正在退出的同 id 卡片「复活」：队列瞬时增删（切歌快照连推）时
          // 不新建重复节点，直接取消死亡继续用。
          for (var d = 0; d < dying.length; d += 1) {
            if (dying[d].dataset.id === String(item.id)) {
              el = dying[d];
              el._pose.dead = 0;
              dying.splice(d, 1);
              nodes.set(item.id, el);
              break;
            }
          }
        }
        if (!el) {
          el = buildNode(item, i);
          el._pose.spawn = active ? now : 0;
          nodes.set(item.id, el);
        } else {
          updateNode(el, item);
        }
        if (el.parentNode !== plane) plane.appendChild(el);
      });
      // 按数据顺序排 DOM
      next.forEach(function (item) {
        var el = nodes.get(item.id);
        if (el && el.parentNode === plane) plane.appendChild(el);
      });

      items = next;
      items.forEach(function (it) { if (it.cover) preloadCover(it.cover); });
      repaintTags();

      // 封面流居中跟踪「正在播放」在队列里的实际位置（队列不重排，自然切歌时
      // 当前曲从 i 走到 i+1，center 从旧值平滑滑过去，形成整排卡片横移的换歌
      // 动画）。仅当新当前曲是全新节点（队列外直接点歌）时才硬切居中并重跑
      // 召唤；老节点一律保留 center 旧值交给帧循环插值。
      var ci = currentIndex();
      var curIdNow = items[ci] ? String(items[ci].id) : null;
      var currentIsNew = !(curIdNow && oldIds[curIdNow]);
      if (currentIsNew || items.length === 0) center = ci;
      browseIndex = 0;
      applyVisibility();
    }

    function attachCoverLoad(el) {
      var img = el.querySelector('img');
      img.addEventListener('load', function () { img.classList.add('is-loaded'); });
      img.addEventListener('error', function () { img.classList.remove('is-loaded'); });
    }

    function findLiveNode(id) {
      return nodes.has(id) ? nodes.get(id) : null;
    }

    // ---- pose（applyFloatingSongCardPose 的 DOM 版）-----------------------

    function poseStage(delta, absD, hover, active0, pulse, reveal, entry, w, h) {
      var breath = Math.sin(t * 0.92 + delta * 0.64) * 0.052;
      var breathZ = Math.cos(t * 0.78 + delta * 0.52) * 0.03;
      var x = delta * w * 0.58
        + entry * delta * w * 0.09
        - hover * w * 0.03;
      var y = -entry * h * 0.21
        + pointer.y * 10
        + breath * h * 0.7;
      var z = -Math.min(2, absD) * 150
        - entry * 80
        + hover * 22
        + breathZ * 30;
      var rotY = -delta * 12.6;
      var rotX = 5.7 - absD * 2.3 - hover * 0.86 - pointer.y * 3;
      var s0 = absD < 0.5 ? 1.2 : Math.max(0.45, 1 - absD * 0.22);
      var scale = s0 * (1 + pulse * 0.06 + hover * 0.04 + active0 * 0.04)
        * (1 - (1 - reveal) * 0.18);
      return { x: x, y: y, z: z, rotY: rotY, rotX: rotX, scale: scale };
    }

    function poseSide(delta, absD, hover, active0, pulse, reveal, entry, w, h) {
      var breath = Math.sin(t * 0.92 + delta * 0.64) * 0.052;
      var x = absD * w * 0.088
        + entry * 22
        - hover * w * 0.07;
      var y = -delta * h * 0.72
        + (1 - reveal) * (delta < 0 ? -10 : 10)
        + hover * h * 0.10
        + breath * h * 0.4;
      var z = -absD * 55 - entry * 60 + hover * 64;
      var rotY = 5 - hover * 4.6;
      var rotX = -delta * 2.4;
      var s0 = absD < 0.5 ? 1.12 : Math.max(0.55, 1.04 - absD * 0.14);
      var scale = s0 * (1 + pulse * 0.056 + hover * 0.05 + active0 * 0.05)
        * (1 - (1 - reveal) * 0.20);
      return { x: x, y: y, z: z, rotY: rotY, rotX: rotX, scale: scale };
    }

    // ---- 帧循环 --------------------------------------------

    function computeBass(playing) {
      if (!playing || !Stage || !Stage.spectrum) return 0;
      var bands = Stage.spectrum();
      if (!bands || !bands.length) return 0;
      var n = Math.max(1, Math.floor(bands.length / 8));
      var sum = 0;
      for (var i = 0; i < n; i += 1) sum += Number(bands[i]) || 0;
      return clamp(sum / n * 1.8, 0, 1);
    }

    function frame(dtMs) {
      if (!active || mode === 'off') return;
      var reduced = reducedMotion();
      var data = Stage && Stage.presentation ? Stage.presentation() : null;
      var playing = !!(data && data.playing);
      var progress = data && data.duration > 0 ? clamp(data.position / data.duration, 0, 1) : 0;

      if (!reduced) t += dtMs / 1000;

      var bassTarget = computeBass(playing);
      bass += (bassTarget - bass) * 0.2;
      if (Math.abs(bassTarget - bass) < 0.002) bass = bassTarget;

      // 切歌脉冲：当前曲 id 变化时给新中央卡一次按下反馈
      var curId = data && data.track ? data.track.id : null;
      if (curId && curId !== lastCurrentId) {
        var hit = nodes.get(String(curId));
        if (hit) hit._pose.pulse = 1;
        lastMetaPct = -1;
      }
      lastCurrentId = curId;

      // 滚轮浏览自动回到当前曲
      var ci = currentIndex();
      var target = ci + browseIndex;
      if (browseIndex !== 0 && Date.now() - browseAt > BROWSE_RETURN_MS) {
        browseIndex = 0;
        target = ci;
      }
      center += (target - center) * LERP_CENTER;
      if (Math.abs(center - target) < 0.001) center = target;

      var now = performance.now();
      var radius = visibleRadius();

      items.forEach(function (item, i) {
        var el = nodes.get(item.id);
        if (!el) return;
        el._wasIndex = i;
        var p = el._pose;
        var delta = i - center;
        var absD = Math.abs(delta);
        var visible = absD <= radius;
        if (!visible) {
          el.style.visibility = 'hidden';
          return;
        }
        el.style.visibility = 'visible';

        // 召唤（含逐卡 stagger）
        if (!p.spawn) p.spawn = now;
        var stagger = Math.min(STAGGER_CAP, i * SUMMON_STAGGER);
        var raw = reduced ? 1 : (now - p.spawn) / SUMMON_OPEN_MS;
        var reveal = clamp(smoothstep(clamp((raw - stagger) / Math.max(0.001, 1 - stagger), 0, 1)), 0, 1);
        var entry = (1 - reveal) * 1.9;

        var isHover = hoverId === item.id;
        var targetHover = isHover ? 1 : 0;
        p.hover += (targetHover - p.hover) * LERP_HOVER;

        p.pulse = (p.pulse || 0) * (reduced ? 0 : 0.9);
        if (p.pulse < 0.01) p.pulse = 0;
        p.reveal = reveal;

        var w = el.offsetWidth || 260;
        var h = el.offsetHeight || 130;
        var pose = mode === 'side'
          ? poseSide(delta, absD, p.hover, item.playing ? 1 : 0, p.pulse, reveal, entry, w, h)
          : poseStage(delta, absD, p.hover, item.playing ? 1 : 0, p.pulse, reveal, entry, w, h);

        var dof = clamp((absD - 0.45) / 3.2, 0, 1);
        var stackOpacity = absD < 0.5 ? 1 : Math.max(0.22, 1 - absD * 0.3);
        var opacity = clamp(reveal * stackOpacity, 0, 1);
        var blur = reduced ? 0 : dof * 2.5;

        el.style.opacity = opacity.toFixed(3);
        el.style.transform =
          'translate(-50%,-50%) translate3d(' + pose.x.toFixed(1) + 'px,' + pose.y.toFixed(1) + 'px,' + pose.z.toFixed(1) + 'px)' +
          ' rotateX(' + pose.rotX.toFixed(2) + 'deg) rotateY(' + pose.rotY.toFixed(2) + 'deg)' +
          ' scale(' + pose.scale.toFixed(4) + ')';
        el.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(2) + 'px)' : '';
        el.style.zIndex = String(100 - Math.round(absD * 10) + (isHover ? 50 : 0));

        if (item.playing) {
          el.style.setProperty('--ring', (1.8 + (reduced ? 0 : Math.sin(t * 3) * 0.28) + bass * 1.2).toFixed(2) + 'px');
          el.style.setProperty('--bass', bass.toFixed(3));
          el.style.setProperty('--p', progress.toFixed(3));
          var pct = Math.round(progress * 100);
          if (pct !== lastMetaPct) {
            lastMetaPct = pct;
            var metaEl = el.querySelector('.s3d-sc-meta');
            if (metaEl) metaEl.textContent = pct + '%' + (item.album ? ' · ' + item.album : '');
          }
        }
      });

      // 退出动画
      for (var k = dying.length - 1; k >= 0; k -= 1) {
        var dEl = dying[k];
        var dp = dEl._pose;
        var gone = reduced ? 1 : (now - dp.dead) / SUMMON_CLOSE_MS;
        if (gone >= 1) {
          if (dEl.parentNode) dEl.parentNode.removeChild(dEl);
          dying.splice(k, 1);
          continue;
        }
        var e2 = 1 - smoothstep(gone);
        dEl.style.opacity = (e2 * 0.9).toFixed(3);
        dEl.style.transform = 'translate(-50%,-50%) translate3d(' + (-46 - gone * 60).toFixed(1) + 'px,0,-120px) rotateY(14deg) scale(' + (0.9 - gone * 0.18).toFixed(3) + ')';
        dEl.style.zIndex = '1';
      }
      // 不在这里每帧 kick：gate 仍在报帧率时主循环自驱，kick 只在
      // show / 滚轮浏览等「从静止醒来」的时刻需要。
    }

    // ---- 显隐 / 模式 --------------------------------------------

    function applyVisibility(respawn) {
      var on = active && mode !== 'off' && items.length > 0;
      root.classList.toggle('s3d-shelf-on', on);
      root.setAttribute('data-shelf-mode', mode);
      plane.hidden = !on;
      // 只有舞台开合 / 模式切换才整排重跑召唤 stagger；切歌重推队列不重播，
      // 否则换歌瞬间整排卡片都会重新滑入，和封面流横移互相打架。
      if (on && respawn) {
        var now = performance.now();
        items.forEach(function (item) {
          var el = nodes.get(item.id);
          if (el) el._pose.spawn = now;
        });
      }
    }

    function show() {
      active = true;
      applyVisibility(true);
      if (Stage && Stage.kick) Stage.kick();
    }

    function hide() {
      active = false;
      root.classList.remove('s3d-shelf-on');
      plane.hidden = true;
    }

    function setMode(next) {
      if (next !== 'off' && next !== 'stage' && next !== 'side') next = 'stage';
      mode = next;
      applyVisibility(true);
      if (active && mode !== 'off' && Stage && Stage.kick) Stage.kick();
    }

    function setBlocked(on) {
      blocked = !!on;
      root.classList.toggle('s3d-shelf-blocked', blocked);
    }

    function gateFps() {
      if (!active || mode === 'off' || blocked || !items.length || document.hidden) return 0;
      if (reducedMotion()) return 20;
      // 暂停时没有频谱律动，30fps 足够呼吸与滑动；eco 档同样压到 30。
      var p = Stage && Stage.presentation ? Stage.presentation() : null;
      if (eco() || !p || !p.playing) return 30;
      return 60;
    }

    function destroy() {
      if (Stage && Stage.removeGate) Stage.removeGate('stage3d-shelf');
      root.removeEventListener('wheel', onWheelCapture, true);
      document.removeEventListener('pointermove', onPointerTrack, true);
      plane.innerHTML = '';
      nodes.clear();
      dying = [];
      items = [];
    }

    // ---- init --------------------------------------------

    if (!inited) {
      inited = true;
      plane.hidden = true;
      root.addEventListener('wheel', onWheelCapture, true);
      document.addEventListener('pointermove', onPointerTrack, { passive: true, capture: true });
      if (Stage && Stage.gate) Stage.gate('stage3d-shelf', gateFps, frame);
    }

    return {
      setItems: setItems,
      show: show,
      hide: hide,
      setMode: setMode,
      setBlocked: setBlocked,
      destroy: destroy
    };
  }

  var api = null;
  global.StageShelf = {
    init: function (root) {
      if (!api) api = StageShelf(root);
      return api;
    },
    api: function () { return api; }
  };
}(typeof window !== 'undefined' ? window : this));
