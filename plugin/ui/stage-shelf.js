// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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
  var COVER_CACHE_CAP = 40;        // 当前窗口与相邻卡片的预加载缓存上限
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
    var items = [];                 // 完整队列，顺序与队列面板一致
    var playingIndex = 0;
    var windowStart = -1;
    var windowEnd = -1;
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

    // ---- 封面地址解析：队列元数据里存的是音源 https 原址（app.js 故意不回写
    // base64，见它 1540 行附近的注释），插件沙箱的 img-src 画不出来。HertzCovers.slot
    // 在插件形态登记回填并触发 sidecar 代理；独立形态同步用原址回调，调用点不分支。
    function resolveCover(url, apply) {
      if (global.HertzCovers && global.HertzCovers.slot) { global.HertzCovers.slot(url, apply); return; }
      apply(url);
    }

    // ---- 封面预加载：切歌时新卡直接命中缓存，交叉淡化不黑帧
    function preloadCover(url) {
      if (!url || coverCache.has(url)) return;
      var img = new Image();
      img.decoding = 'async';
      coverCache.set(url, img);
      resolveCover(url, function (resolved) { if (resolved) img.src = resolved; });
      while (coverCache.size > COVER_CACHE_CAP) coverCache.delete(coverCache.keys().next().value);
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
      // dataset.url 仍记**原址**作去重键；真正赋给 img 的是代理落地后的 data URL。
      resolveCover(url, function (resolved) {
        if (!resolved || img.dataset.url !== url) return;   // 卡已换歌，别回填旧图
        img.src = resolved;
      });
      // 预加载缓存里已就绪的图直接亮出：新卡首帧就是封面，
      // 不会先渲染一帧空卡再淡入（观感即「封面闪烁」）。
      var pre = coverCache.get(url);
      if (pre && pre.complete && pre.naturalWidth > 0) img.classList.add('is-loaded');
    }

    function repaintTags() {
      var ci = currentIndex();
      nodes.forEach(function (el) {
        var i = el._queueIndex;
        var item = items[i];
        setText(el, '.s3d-sc-tag', tagFor(i, ci) + ' · ' + (i + 1) + ' / ' + items.length);
        el.setAttribute('aria-label', (item.title || '未知曲目') + '，第 ' + (i + 1) + ' 首，共 ' + items.length + ' 首');
      });
    }

    // ---- 卡片手势（点击跳播 / 触摸横滑浏览）-------------------------------

    function bindCard(el, id) {
      var down = null;
      var browseBands = 0;

      el.addEventListener('pointerdown', function (e) {
        if (!active || blocked || down || e.button !== 0 || e.isPrimary === false) return;
        // 卡片不在画布层内，但仍显式吃掉事件，避免任何上层捕获逻辑误判为拖拽
        e.stopPropagation();
        down = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0 };
        browseBands = 0;
        // 指针捕获不是所有内核都支持：拿不到就退化成普通监听，不影响点选。
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      });

      el.addEventListener('pointermove', function (e) {
        if (!down || e.pointerId !== down.id) return;
        down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
        var band;
        if (mode === 'side') {
          // 右侧竖向架：上下拖动浏览（向下=后续曲目），按卡片高度取带。
          var dy = e.clientY - down.y;
          var step = el.offsetHeight || 96;
          band = Math.trunc(dy / step);
        } else {
          // 横向封面流：左右拖动
          var dx = e.clientX - down.x;
          band = Math.trunc(-dx / 44);
        }
        if (band !== browseBands) {
          nudgeBrowse(band - browseBands);
          browseBands = band;
        }
      });

      function finish(e, cancelled) {
        if (!down || e.pointerId !== down.id) return;
        var moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
        down = null;
        // 同上：没捕获成功就没有要释放的，忽略即可。
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (cancelled || moved > CLICK_THRESHOLD || browseBands !== 0) return;
        onCardTap(id);
      }

      el.addEventListener('pointerup', function (e) { finish(e, false); });
      el.addEventListener('pointercancel', function (e) { finish(e, true); });
      el.addEventListener('lostpointercapture', function (e) { finish(e, true); });
      el._cancelDrag = function () { if (down) finish({ pointerId: down.id }, true); };

      el.addEventListener('mouseenter', function () { hoverId = id; });
      el.addEventListener('mouseleave', function () { if (hoverId === id) hoverId = null; });
    }

    function onCardTap(id) {
      var idx = indexOfId(id);
      if (idx < 0) return;
      if (idx === currentIndex()) {
        document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: 'toggle' } }));
      } else {
        document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: 'queue-play', value: id } }));
      }
    }

    function indexOfId(id) {
      for (var i = 0; i < items.length; i += 1) if (items[i].id === id) return i;
      return -1;
    }

    function currentIndex() {
      return playingIndex;
    }

    // ---- 滚轮浏览（在舞台根节点捕获，贴近歌单架区域才截给架子）-------------

    function onPointerTrack(e) {
      if (!active || blocked || document.hidden || reducedMotion()) return;
      pointer.x = clamp(e.clientX / Math.max(1, global.innerWidth) * 2 - 1, -1, 1);
      pointer.y = clamp(e.clientY / Math.max(1, global.innerHeight) * 2 - 1, -1, 1);
    }

    function onWheelCapture(e) {
      if (!active || mode === 'off' || blocked || !items.length) return;
      if (e.ctrlKey || e.metaKey || !e.target.closest || !plane.contains(e.target.closest('.s3d-sc'))) return;
      var delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();
      var now = Date.now();
      if (now - lastWheelAt < WHEEL_COOLDOWN_MS) return;
      lastWheelAt = now;
      nudgeBrowse(delta > 0 ? 1 : -1);
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

    function setItems(list) {
      if (!root.classList.contains('s3d-chrome')) clearDying();
      var oldIndex = currentIndex();
      var oldCurrent = items[oldIndex];
      var oldBrowse = items[oldIndex + browseIndex];
      items = Array.isArray(list) ? list.slice() : [];
      playingIndex = 0;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].playing) { playingIndex = i; break; }
      }
      var current = items[playingIndex];
      if (oldCurrent && current && oldCurrent.id === current.id) {
        // 同曲的元数据回填或队列重排不打断浏览；位置仍由完整队列决定。
        center += playingIndex - oldIndex;
        var nextBrowse = oldBrowse ? indexOfId(oldBrowse.id) : -1;
        browseIndex = nextBrowse < 0 ? 0 : nextBrowse - playingIndex;
      } else {
        // 相邻切歌保留平滑横移；跳到窗口外的曲目直接定位，避免扫过整条长队列。
        if (!current || !nodes.has(current.id)) center = playingIndex;
        browseIndex = 0;
      }
      center = clamp(center, 0, Math.max(0, items.length - 1));
      syncWindow(true);
      if (!items.length) clearDying();
      applyVisibility();
    }

    // 只限制节点和预载，不截断队列。窗口跟随浏览中心，最多绘制两侧半径内的卡片。
    function syncWindow(force) {
      var radius = Math.ceil(visibleRadius());
      var anchor = Math.round(center);
      var start = Math.max(0, anchor - radius);
      var end = Math.min(items.length, anchor + radius + 1);
      if (!force && start === windowStart && end === windowEnd) return;
      windowStart = start;
      windowEnd = end;
      var next = items.slice(start, end);
      var nextIds = new Set(next.map(function (item) { return item.id; }));
      var now = performance.now();

      nodes.forEach(function (el, id) {
        if (nextIds.has(id)) return;
        if (el._cancelDrag) el._cancelDrag();
        // 滚出窗口直接回收；真正离队的卡片才演出退出动画。
        if (indexOfId(id) >= 0 || !active || blocked || document.hidden || !root.classList.contains('s3d-chrome') || mode === 'off' || reducedMotion()) {
          if (el.parentNode) el.parentNode.removeChild(el);
        } else {
          el._pose.dead = now;
          el.style.pointerEvents = 'none';
          dying.push(el);
        }
        if (hoverId === id) hoverId = null;
        nodes.delete(id);
      });
      while (dying.length > radius * 2 + 1) {
        var retired = dying.shift();
        if (retired.parentNode) retired.parentNode.removeChild(retired);
      }

      // 新卡建节点；顺序变动只搬序，不重建（封面 img 缓存不闪）
      next.forEach(function (item, offset) {
        var i = start + offset;
        var el = nodes.get(item.id);
        if (!el) {
          // 正在退出的同 id 卡片「复活」：队列瞬时增删（切歌快照连推）时
          // 不新建重复节点，直接取消死亡继续用。
          for (var d = 0; d < dying.length; d += 1) {
            if (dying[d].dataset.id === String(item.id)) {
              el = dying[d];
              el._pose.dead = 0;
              el.style.pointerEvents = '';
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
          if (item.playing) lastMetaPct = -1;
        } else {
          updateNode(el, item);
        }
        el._queueIndex = i;
        el.dataset.index = String(i);
        if (el.parentNode !== plane) plane.appendChild(el);
      });
      // 按数据顺序排 DOM
      next.forEach(function (item) {
        var el = nodes.get(item.id);
        if (el && el.parentNode === plane) plane.appendChild(el);
      });

      repaintTags();
    }

    function attachCoverLoad(el) {
      var img = el.querySelector('img');
      img.addEventListener('load', function () { img.classList.add('is-loaded'); });
      img.addEventListener('error', function () {
        img.classList.remove('is-loaded');
        // 失败的 URL 必须允许重试：在线封面常见「详情晚到/代理图首次 404」，
        // 若留着 dataset.url，后续队列重推会命中同 URL 早退，卡面永远黑着。
        // 清掉记录与预加载缓存里的失败项，下一次 setItems 就会重新赋 src。
        var failed = img.dataset.url;
        if (failed) {
          img.dataset.url = '';
          img.removeAttribute('src');
          var bad = coverCache.get(failed);
          if (bad && !bad.naturalWidth) coverCache.delete(failed);
        }
      });
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
      // blocked 只该禁输入（拖拽/滚轮/命中，见 setBlocked 与各输入口），不能停姿态：
      // 设置面板是改「3D 歌单架」的唯一入口，而面板打开即 blocked——姿态若冻住，
      // 切 封面流/侧栏/关闭 就完全没有视觉反馈，观感即设置没反应。
      if (!active || document.hidden || !root.classList.contains('s3d-chrome') || mode === 'off') return;
      var reduced = reducedMotion();
      var data = Stage && Stage.presentation ? Stage.presentation() : null;
      var playing = !!(data && data.playing);
      var progress = data && data.duration > 0 ? clamp(data.position / data.duration, 0, 1) : 0;

      if (!reduced) t += dtMs / 1000;

      if (reduced) pointer.x = pointer.y = 0;
      var bassTarget = reduced ? 0 : computeBass(playing);
      bass += (bassTarget - bass) * (reduced ? 1 : 1 - Math.pow(0.8, dtMs / (1000 / 60)));
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
      center += (target - center) * (reduced ? 1 : 1 - Math.pow(1 - LERP_CENTER, dtMs / (1000 / 60)));
      if (Math.abs(center - target) < 0.001) center = target;
      syncWindow();

      var now = performance.now();
      var radius = visibleRadius();

      nodes.forEach(function (el) {
        var i = el._queueIndex;
        var item = items[i];
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
        var stagger = Math.min(STAGGER_CAP, absD * SUMMON_STAGGER);
        var raw = reduced ? 1 : (now - p.spawn) / SUMMON_OPEN_MS;
        var reveal = clamp(smoothstep(clamp((raw - stagger) / Math.max(0.001, 1 - stagger), 0, 1)), 0, 1);
        var entry = (1 - reveal) * 1.9;

        var isHover = hoverId === item.id;
        var targetHover = isHover ? 1 : 0;
        p.hover += (targetHover - p.hover) * (reduced ? 1 : 1 - Math.pow(1 - LERP_HOVER, dtMs / (1000 / 60)));

        p.pulse = (p.pulse || 0) * (reduced ? 0 : Math.pow(0.9, dtMs / (1000 / 60)));
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
        nodes.forEach(function (el) { el._pose.spawn = now; });
      }
    }

    function show() {
      active = true;
      applyVisibility(true);
      if (Stage && Stage.kick) Stage.kick();
    }

    function hide() {
      cancelDrags();
      clearDying();
      active = false;
      root.classList.remove('s3d-shelf-on');
      plane.hidden = true;
    }

    function setMode(next) {
      cancelDrags();
      if (next !== 'off' && next !== 'stage' && next !== 'side') next = 'stage';
      mode = next;
      if (mode === 'off') clearDying();
      applyVisibility(true);
      if (active && mode !== 'off' && Stage && Stage.kick) Stage.kick();
    }

    function setBlocked(on) {
      blocked = !!on;
      if (blocked) { cancelDrags(); clearDying(); }
      root.classList.toggle('s3d-shelf-blocked', blocked);
      if (!blocked && active && Stage && Stage.kick) Stage.kick();
    }

    function cancelDrags() {
      nodes.forEach(function (el) { if (el._cancelDrag) el._cancelDrag(); });
    }

    function clearDying() {
      dying.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
      dying = [];
    }

    function onVisibilityChange() {
      if (document.hidden) { cancelDrags(); clearDying(); }
      else if (active && Stage && Stage.kick) Stage.kick();
    }

    function gateFps() {
      // blocked 不在这里出现：面板打开只该让架子「不可交互」（CSS pointer-events
      // 与各输入口收口），不该停帧——停帧等于冻结排布，而「3D 歌单架」这个选项
      // 只能在面板里改，改完看不到任何重排，观感就是设置没反应。
      if (!active || mode === 'off' || !items.length || document.hidden) return 0;
      if (!root.classList.contains('s3d-chrome')) return 0;
      if (reducedMotion()) return 20;
      // 暂停时没有频谱律动，30fps 足够呼吸与滑动；eco 档同样压到 30。
      var p = Stage && Stage.presentation ? Stage.presentation() : null;
      if (eco() || !p || !p.playing) return 30;
      return 60;
    }

    function destroy() {
      hide();
      window.removeEventListener('blur', cancelDrags);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (Stage && Stage.removeGate) Stage.removeGate('stage3d-shelf');
      root.removeEventListener('wheel', onWheelCapture, true);
      document.removeEventListener('pointermove', onPointerTrack, true);
      plane.innerHTML = '';
      nodes.clear();
      coverCache.clear();
      dying = [];
      items = [];
    }

    // ---- init --------------------------------------------

    if (!inited) {
      inited = true;
      window.addEventListener('blur', cancelDrags);
      document.addEventListener('visibilitychange', onVisibilityChange);
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
