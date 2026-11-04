(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const systemTheme = matchMedia('(prefers-color-scheme: light)');

  const state = {
    config: { theme: 'auto', scale: 1, opacity: 1, pet: false, locked: false, topmost: true, edgeHide: false, dock: 'none', sung: '' },
    snapshot: null,
    // 拖拽阈值：小于这个位移仍然算点击（走展开），与主界面胶囊一致。
    dragPx: 4,
    dragging: false,
    hoverTimer: 0,
    hitFrame: 0,
    flashTimer: 0,
  };

  function ipc(payload) {
    try { window.ipc.postMessage(JSON.stringify(payload)); } catch (_) { /* 浏览器里直接打开时的降级 */ }
  }

  function flash(text, ms) {
    const el = $('flash');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => { el.hidden = true; }, ms || 1600);
  }

  // --- 宠物资源层 ==========================================================
  // skin = { name, size:[w,h], states: { <状态>: { fps, loop, frames:[url,...] } } }
  // 状态清单：idle 待机/暂停 · playing 播放中 · dragging 拖拽 · tap 点按一次性
  // 生效皮肤 = 用户素材与内置默认按状态合并；单个状态缺失时按
  // 「用户该状态 → 用户 idle → 内置该状态 → 内置 idle」逐级兜底，永不空窗。
  // 内置默认也是普通素材（data-URL SVG），走同一条 <img> 管线，没有特权路径；
  // 连默认都画不出来才退回 ♫ 封面块（body[data-art-failed]）。
  // 换肤入口：宿主伺服 mini-skin/pet.json（文件名约定或清单声明帧），
  // 页面加载后把生效尺寸经 pet-size 交给 native 决定收起态窗体形状。
  const petArt = (() => {
    const svg = body => 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 96 96">' +
      '<defs><radialGradient id="g" cx="35%" cy="28%" r="85%">' +
      '<stop offset="0" stop-color="#ffb066"/><stop offset="1" stop-color="#ff7a2f"/>' +
      '</radialGradient></defs>' + body + '</svg>');
    const blob = (cy, rx, ry) =>
      `<ellipse cx="48" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#g)"/>` +
      `<path d="M46 ${(cy - ry + .5).toFixed(1)}q1-11 11-12.5" fill="none" stroke="#e0561a" stroke-width="3.5" stroke-linecap="round"/>` +
      `<ellipse cx="33" cy="${cy + 4}" rx="4.5" ry="2.8" fill="#e0561a" opacity=".35"/>` +
      `<ellipse cx="63" cy="${cy + 4}" rx="4.5" ry="2.8" fill="#e0561a" opacity=".35"/>`;
    const eyesOpen = '<circle cx="39" cy="52" r="3.4" fill="#3a1d0b"/><circle cx="57" cy="52" r="3.4" fill="#3a1d0b"/>' +
      '<circle cx="40.2" cy="50.6" r="1.1" fill="#fff"/><circle cx="58.2" cy="50.6" r="1.1" fill="#fff"/>';
    const eyesHappy = '<path d="M35.5 52q3.5-4.5 7 0M53.5 52q3.5-4.5 7 0" fill="none" stroke="#3a1d0b" stroke-width="2.6" stroke-linecap="round"/>';
    const eyesClosed = '<path d="M35.5 52.5h7M53.5 52.5h7" stroke="#3a1d0b" stroke-width="2.6" stroke-linecap="round"/>';
    const mouthSing = '<ellipse cx="48" cy="62.5" rx="3.4" ry="4.4" fill="#3a1d0b"/>';
    const mouthSmile = '<path d="M42.5 60q5.5 6.5 11 0z" fill="#3a1d0b"/>';
    const note = (dy, op = 1) =>
      `<g fill="#8a3d12" opacity="${op}" transform="translate(0 ${dy})">` +
      '<ellipse cx="67" cy="35" rx="4" ry="3"/><rect x="69.4" y="20" width="2.6" height="15" rx="1.3"/>' +
      '<path d="M72 20q6.5 2.5 5 9.5c-1.2-3.2-2.8-4.8-5-5.4z"/></g>';
    return {
      playing1: svg(blob(55, 29, 27) + eyesOpen + mouthSing + note(0)),
      playing2: svg(`<g transform="translate(0 -3)">${blob(55, 29.5, 26)}</g>` + eyesHappy + mouthSmile + note(-5)),
      idle: svg(blob(55, 29, 27) + eyesClosed +
        '<path d="M45.5 62h5" stroke="#3a1d0b" stroke-width="2.4" stroke-linecap="round"/>' + note(0, .35)),
      drag: svg(blob(55, 29, 27) +
        '<circle cx="39" cy="52" r="4.2" fill="#3a1d0b"/><circle cx="57" cy="52" r="4.2" fill="#3a1d0b"/>' +
        '<circle cx="40.4" cy="50.4" r="1.3" fill="#fff"/><circle cx="58.4" cy="50.4" r="1.3" fill="#fff"/>' +
        '<circle cx="48" cy="62.5" r="3.4" fill="#3a1d0b"/>' + note(0) +
        '<path d="M10 47h8M8 57h8M78 47h8M80 57h8" stroke="#e0561a" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M80 18l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#ffb066"/>'),
      tap: svg(blob(60, 33, 21.5) + eyesHappy +
        '<ellipse cx="48" cy="66" rx="5" ry="3.6" fill="#3a1d0b"/>' + note(-9)),
    };
  })();

  const DEFAULT_SKIN = {
    name: '内置 · 橙团子',
    size: [56, 56],
    states: {
      idle:     { fps: 2, loop: true,  frames: [petArt.idle] },
      playing:  { fps: 4, loop: true,  frames: [petArt.playing1, petArt.playing2] },
      dragging: { fps: 6, loop: true,  frames: [petArt.drag] },
      tap:      { fps: 8, loop: false, frames: [petArt.tap] },
    },
  };

  const Pet = (() => {
    const STATES = ['idle', 'playing', 'dragging', 'tap'];
    const img = $('pet-art');
    let skin = null, cur = null, frame = 0, oneShot = null, timer = 0, running = false;
    let loadGeneration = 0;
    const failedFrames = new Set();
    const clamp = value => Math.min(160, Math.max(48, Math.round(Number(value) || 56)));

    // A failed candidate is retired for this load, including failures discovered after
    // preload. Each state has a finite, ordered chain; no bad URL is retried by a timer.
    function definition(name) {
      return skin.states[name].find(def => !def.frames.some(url => failedFrames.has(url)));
    }
    img.addEventListener('error', () => {
      const url = img.getAttribute('src');
      if (!skin || !url || failedFrames.has(url)) return;
      failedFrames.add(url);
      cur = null; frame = 0;
      if (running) { clearTimeout(timer); step(); }
    });
    img.addEventListener('load', () => {
      document.body.removeAttribute('data-art-failed');
      scheduleHitRegions();
    });

    function setSkin(manifest) {
      const states = {};
      for (const name of STATES) {
        const fallback = DEFAULT_SKIN.states[name];
        const candidates = [manifest.states[name], manifest.states.idle, fallback, DEFAULT_SKIN.states.idle];
        states[name] = [...new Set(candidates.filter(Boolean))].map(def => ({
          fps: Math.min(24, Math.max(1, Math.round(Number(def.fps) || fallback.fps || 6))),
          loop: def.loop === undefined ? fallback.loop !== false : !!def.loop,
          frames: def.frames,
        }));
      }
      skin = { size: (manifest.size || DEFAULT_SKIN.size).map(clamp), states };
      failedFrames.clear();
      petOpaqueCache.clear();
      cur = null; frame = 0; oneShot = null;
      ipc({ cmd: 'pet-size', width: skin.size[0], height: skin.size[1] });
      if (state.config.pet) {
        if (running) { clearTimeout(timer); step(); } else start();
      }
    }

    // 状态优先级：拖拽 > 一次性反应 > 播放/待机。
    function pickState() {
      if (state.dragging) return 'dragging';
      if (oneShot) return oneShot;
      return state.snapshot && state.snapshot.playing ? 'playing' : 'idle';
    }
    function step() {
      if (!running) return;
      let name = pickState();
      let def = definition(name);
      if (name !== cur) { cur = name; frame = 0; }
      if (def && frame >= def.frames.length) {
        frame = 0;
        // A one-shot invocation ends after one sequence, even when its
        // fallback is an otherwise looping idle/playing animation.
        if (oneShot === name) {
          oneShot = null;
          name = pickState(); cur = name;
          def = definition(name);
        }
      }
      if (!def) {
        document.body.setAttribute('data-art-failed', '');
        scheduleHitRegions();
        return;
      }
      const url = def.frames[frame];
      // Stable state snapshots and single-frame GIFs never reset their src.
      if (img.getAttribute('src') !== url) img.src = url;
      frame += 1;
      timer = setTimeout(step, Math.max(40, 1000 / def.fps));
    }
    function start() { if (running || !skin) return; running = true; cur = null; step(); }
    function stop() { running = false; clearTimeout(timer); }
    function sync() {
      if (running && pickState() !== cur) { clearTimeout(timer); step(); }
    }
    function oneShotPlay(name) {
      if (running && skin.states[name]) { oneShot = name; cur = null; sync(); }
    }

    const SKIN_EXTS = ['png', 'gif', 'webp', 'svg', 'jpg', 'jpeg'];
    const withRevision = (url, revision) => `${url}?mini-rev=${revision}`;
    async function probeFrame(url) {
      try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        return response.ok;
      } catch (_) { return false; }
    }
    async function framesByConvention(name, revision) {
      const find = async stem => {
        for (const ext of SKIN_EXTS) {
          const url = withRevision(`mini-skin/${stem}.${ext}`, revision);
          if (await probeFrame(url)) return url;
        }
        return null;
      };
      // Both idle.png + idle-2.png and idle-1.png + idle-2.png are accepted.
      const first = await find(name) || await find(`${name}-1`);
      if (!first) return [];
      const frames = [first];
      for (let index = 2; index <= 64; index += 1) {
        const url = await find(`${name}-${index}`);
        if (!url) break;
        frames.push(url);
      }
      return frames;
    }
    function decodeFrame(url) {
      return new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth && image.naturalHeight ?
          [image.naturalWidth, image.naturalHeight] : null);
        image.onerror = () => resolve(null);
        image.src = url;
      });
    }
    async function loadUserSkin() {
      const generation = ++loadGeneration;
      const revision = `${Date.now()}-${generation}`;
      let spec = null;
      try {
        const response = await fetch(withRevision('mini-skin/pet.json', revision), { cache: 'no-store' });
        if (response.ok) spec = await response.json();
      } catch (_) { /* 没有素材目录：内置默认。 */ }
      if (generation !== loadGeneration) return;
      const manifest = { size: null, states: {} };
      if (spec && Array.isArray(spec.size) && spec.size.length === 2 &&
          spec.size.every(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
        manifest.size = spec.size;
      }
      const decoded = new Map();
      let inferredSize = null;
      for (const name of STATES) {
        if (generation !== loadGeneration) return;
        const def = spec && spec.states && spec.states[name];
        let urls;
        if (def && Array.isArray(def.frames) && def.frames.length) {
          urls = def.frames.slice(0, 64).map(file => typeof file === 'string' && file.trim() ?
            withRevision(`mini-skin/${file.trim().toLowerCase()}`, revision) : null);
        } else {
          urls = await framesByConvention(name, revision);
        }
        if (!urls.length || urls.some(url => !url)) continue;
        const sizes = await Promise.all(urls.map(url => {
          if (!decoded.has(url)) decoded.set(url, decodeFrame(url));
          return decoded.get(url);
        }));
        if (generation !== loadGeneration) return;
        // A partial explicit animation is not silently reordered or shortened.
        if (sizes.some(size => !size)) continue;
        if (!inferredSize) inferredSize = sizes[0];
        manifest.states[name] = { fps: def && def.fps, loop: def && def.loop, frames: urls };
      }
      if (generation !== loadGeneration) return;
      manifest.size = manifest.size || inferredSize;
      setSkin(manifest);
    }

    return { start, stop, sync, oneShotPlay, loadUserSkin };
  })();

  // --- 配置 -----------------------------------------------------------------

  // 与桌面歌词同一规则：显式颜色直接用；白（或无效）按主题落中性。
  // 小窗的功能 accent（进度/焦点环/贴边残条）绑用户已唱色，由 native 随 applyConfig 下发。
  function sungAccent(value, theme) {
    const text = String(value || '').trim();
    let hex = null;
    if (/^#[0-9a-f]{6,8}$/i.test(text)) hex = text.slice(0, 7).toLowerCase();
    else if (/^#[0-9a-f]{3}$/i.test(text)) hex = '#' + [...text.slice(1)].map(c => c + c).join('');
    if (!hex || hex === '#ffffff') return theme === 'light' ? '#0b0d11' : '#ffffff';
    return hex;
  }

  function applyConfig(value) {
    if (!value) return;
    state.config = Object.assign({}, state.config, value);
    const c = state.config;
    const theme = c.theme === 'auto' ? (systemTheme.matches ? 'light' : 'dark') : c.theme;
    document.body.dataset.theme = theme;
    root.style.setProperty('--lyric-sung', sungAccent(c.sung, theme));
    document.body.dataset.pet = String(!!c.pet);
    document.body.dataset.locked = String(!!c.locked);
    document.body.dataset.peek = String(!!c.peek);
    root.style.setProperty('--scale', String(c.scale || 1));
    root.style.setProperty('--opacity', String(c.opacity == null ? 1 : c.opacity));
    scheduleHitRegions();
    // 宠物态开关驱动素材动画引擎；皮肤尺寸由 pet-size 上报，这里只管起停。
    if (c.pet) Pet.start(); else Pet.stop();
  }

  // --- 快照与进度 -----------------------------------------------------------

  function applySnapshot(value) {
    state.snapshot = value || null;
    const track = value && value.track;
    $('title').textContent = track ? track.title : '未在播放';
    $('subtitle').textContent = track
      ? [track.artist, track.album].filter(Boolean).join(' · ') || '—'
      : '—';
    document.body.dataset.playing = String(!!(value && value.playing));
    document.body.classList.toggle('buffering', !!(value && value.buffering));
    const play = $('play');
    if (play) play.setAttribute('aria-label', value && value.playing ? '暂停' : '播放');
    renderPosition(value ? value.positionMs : 0, value ? value.durationMs : 0);
    Pet.sync(); // 播放/暂停直接映射到素材状态 playing / idle
    scheduleHitRegions();
  }

  /// 进度由 native 的呈现时钟推进（4Hz），页面不做二次插值——
  /// 两边都插值会叠加漂移，判定「谁是对的」比省一次 evaluate_script 贵得多。
  function applyPosition(value) {
    if (!value) return;
    renderPosition(value.ms || 0, value.durationMs || 0);
  }

  function renderPosition(ms, durationMs) {
    const ratio = durationMs > 0 ? Math.min(1, ms / durationMs) : 0;
    root.style.setProperty('--p', `${(ratio * 100).toFixed(2)}%`);
  }

  function applyCover(dataUrl) {
    const img = $('cover-img');
    if (!img) return;
    if (!dataUrl) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.src = dataUrl;
  }

  // --- 命中区上报 -----------------------------------------------------------

  /// 把所有 [data-hit] 元素的矩形交给 native。宠物态下这些矩形之外的地方
  /// 在 WM_NCHITTEST 里会被判成 HTTRANSPARENT，鼠标直接穿到下面的窗口。
  /// 只在内容/尺寸变化后重算，不在 mousemove 里算。
  function scheduleHitRegions() {
    if (state.hitFrame) return;
    state.hitFrame = requestAnimationFrame(() => {
      state.hitFrame = 0;
      const regions = [];
      document.querySelectorAll('[data-hit]').forEach(el => {
        const box = el.getBoundingClientRect();
        // 宠物态下隐藏掉的文字块宽高为 0，不能上报，否则整条窗都可点。
        if (box.width <= 0 || box.height <= 0) return;
        // 胶囊盒也是 data-hit（胶囊态的拖拽把手）。宠物收起态下它就是整窗矩形，
        // 报上去会把透明角全部堵死——实心区由素材包围盒表达；悬停展开后背板
        // 回来了，胶囊盒必须重新上报（角落是实心的，不能穿透）。
        if (el.id === 'capsule' && state.config.pet && !document.body.classList.contains('hovering')) return;
        if (el.id === 'pet-art') {
          // 宠物素材按不透明包围盒上报：形象画在透明画布上，整盒命中会让
          // 宠物四周失去穿透，宠物态就没意义了。算不出（跨域/SVG 无尺寸）
          // 才退回整盒近似。
          const opaque = petOpaqueBox(box);
          if (opaque) {
            regions.push(opaque);
            return;
          }
        }
        regions.push([round(box.left), round(box.top), round(box.width), round(box.height)]);
      });
      ipc({ cmd: 'hit-regions', regions });
    });
  }
  function round(value) { return Math.round(value * 100) / 100; }

  // 当前帧的不透明包围盒（元素内相对坐标）。按 src 缓存：同一帧反复采样没必要。
  const petOpaqueCache = new Map();
  const opaqueCanvas = document.createElement('canvas');
  function petOpaqueBox(box) {
    const img = $('pet-art');
    const url = img.getAttribute('src');
    if (!url || !img.naturalWidth || !img.naturalHeight) return null;
    if (!petOpaqueCache.has(url)) {
      const naturalWidth = img.naturalWidth, naturalHeight = img.naturalHeight;
      let bounds = null;
      try {
        opaqueCanvas.width = naturalWidth;
        opaqueCanvas.height = naturalHeight;
        const context = opaqueCanvas.getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, naturalWidth, naturalHeight);
        context.drawImage(img, 0, 0);
        const data = context.getImageData(0, 0, naturalWidth, naturalHeight).data;
        let minX = naturalWidth, minY = naturalHeight, maxX = -1, maxY = -1;
        for (let y = 0; y < naturalHeight; y += 1) {
          for (let x = 0; x < naturalWidth; x += 1) {
            if (data[(y * naturalWidth + x) * 4 + 3] > 16) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX >= 0 && maxY >= 0) bounds = { minX, minY, maxX, maxY };
      } catch (_) { bounds = null; }
      petOpaqueCache.set(url, bounds);
    }
    const bounds = petOpaqueCache.get(url);
    if (!bounds) return null;
    // object-fit:contain 的映射：素材等比缩放居中，先算绘制区再放包围盒。
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const drawnWidth = img.naturalWidth * scale, drawnHeight = img.naturalHeight * scale;
    const offsetX = (box.width - drawnWidth) / 2, offsetY = (box.height - drawnHeight) / 2;
    return [
      round(box.left + offsetX + bounds.minX * scale),
      round(box.top + offsetY + bounds.minY * scale),
      round((bounds.maxX - bounds.minX + 1) * scale),
      round((bounds.maxY - bounds.minY + 1) * scale),
    ];
  }

  // --- 拖拽 -----------------------------------------------------------------

  /// 过阈值才交还给 native：native 会自己轮询光标移动窗口，页面不再逐帧上报。
  /// 起手要把抓取偏移一起给过去，否则窗口会跳到光标正下方。
  $('capsule').addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('#transport')) return;
    const startX = event.clientX, startY = event.clientY;
    let started = false;
    const move = ev => {
      if (started) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < state.dragPx) return;
      started = true;
      state.dragging = true;
      document.body.classList.add('dragging');
      Pet.sync(); // 拖拽态素材（dragging）立即接管形象
      try { $('capsule').setPointerCapture(event.pointerId); } catch (_) { /* 拿不到指针也不影响 native 拖 */ }
      ipc({ cmd: 'drag-begin', offsetX: startX, offsetY: startY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      // 刚拖过：这次抬起不要触发展开，等这一轮事件走完再放开。
      setTimeout(() => { state.dragging = false; Pet.sync(); }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // 没拖动的那次点击 = 回到主窗口。
  $('capsule').addEventListener('click', event => {
    if (state.dragging) return;
    if (event.target.closest('#transport')) return;
    ipc({ cmd: 'restore' });
  });

  // --- 播放控制 -------------------------------------------------------------

  const control = (action, value) => ipc({ cmd: 'control', action, value });
  $('prev').addEventListener('click', e => { e.stopPropagation(); control('previous'); Pet.oneShotPlay('tap'); });
  $('next').addEventListener('click', e => { e.stopPropagation(); control('next'); Pet.oneShotPlay('tap'); });
  $('play').addEventListener('click', e => { e.stopPropagation(); control('toggle'); Pet.oneShotPlay('tap'); });

  // --- 右键菜单 -------------------------------------------------------------

  // Native popups can extend beyond the compact WebView's clipped bounds.
  window.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!state.config.locked) ipc({ cmd: 'context-menu' });
  });

  // 悬停驱动两件事：宠物态展开成播放胶囊（pet-hover 交给 native 改窗体尺寸）、
  // 展开态传输键的显隐（hovering 类）。收起延迟 320ms 防边界抖动。
  $('capsule').addEventListener('pointerenter', () => {
    clearTimeout(state.hoverTimer);
    document.body.classList.add('hovering');
    if (state.config.pet) ipc({ cmd: 'pet-hover', on: true });
  });
  $('capsule').addEventListener('pointerleave', () => {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      document.body.classList.remove('hovering');
      if (state.config.pet) ipc({ cmd: 'pet-hover', on: false });
    }, 320);
  });

  window.addEventListener('resize', scheduleHitRegions);
  systemTheme.addEventListener('change', () => applyConfig(state.config));

  // --- 出口 -----------------------------------------------------------------

  window.hertzMini = {
    applySnapshot, applyPosition, applyCover, applyConfig, flash,
    resetInteraction() {
      window.dispatchEvent(new Event('pointercancel'));
      clearTimeout(state.hoverTimer);
      state.dragging = false;
      document.body.classList.remove('hovering', 'dragging');
      Pet.sync();
      scheduleHitRegions();
    },
    // 宿主检测到素材目录变化（tick 签名）后调用：整链重拉，pet-size 随新皮肤上报。
    reloadSkin: () => Pet.loadUserSkin(),
  };
  ipc({ cmd: 'ready' });
  applyConfig(state.config);
  Pet.loadUserSkin(); // 异步：宿主伺服 mini-skin/pet.json，完成后上报 pet-size
})();
