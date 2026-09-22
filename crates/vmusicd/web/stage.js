// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// VCP 风格「音乐模式」舞台控制器。
//
// 职责边界：stage.js 只碰**表现层**——封面转盘、取色背景、歌词渲染与推进、
// 律动环、全屏歌词页。播放逻辑与数据接口仍然在 app.js 里，两边只通过两个
// 契约通信：
//
//   Stage.setTrack / setSnapshot / setSpectrum    ← app.js 喂数据进来
//   document 上的 'stage:control' 自定义事件       → app.js 接用户意图出去
//
// 位置推进不依赖服务端推送频率：快照只给基准点，中间的插值由本地 rAF 时钟
// 补出来，所以逐字卡拉 OK 在 1s 一次的 WS 推送下依然是连续的。

(function () {
  'use strict';

  // 模式合并：逐行（整行亮白）与卡拉OK 渲染管线 90% 重叠，已移除。
  // 老存档里的 'line' 在 setMode 中统一回落到 'karaoke'。
  var BASE_MODES = ['cover', 'karaoke', 'scatter'];
  var STORE_KEY = 'vmusic.stage.mode';
  var WORD_CAP_MS = 1200; // 单字推进上限：脏时间戳给出几十秒的词时不至于爬不动

  var el = {};
  var doc = null;          // LyricDocument
  var views = [];          // [{ container, nodes, big }]
  var mode = 'karaoke';
  var activeIdx = -2;
  var playing = false;
  var track = null;
  var lastCover = null;    // 记住封面，换主题时用它重新取色（retint）

  // 全屏页的背景场景：'cover' 粒子专辑封面 / 'starriver' 星河 / 'off' 仅歌词
  var SCENES = ['cover', 'starriver'];
  var SCENE_KEY = 'vmusic.stage.scene';
  var scene = 'cover';
  var SPIN_KEY = 'vmusic.stage.autospin';
  var autoSpin = false;           // 自动 360° 环转
  var SPIN_DEG_PER_SEC = 5;       // 约 72s 转一圈

  // 本地时钟：base 是快照给的基准点，clockAt 是挂上去的那一刻
  var basePos = 0;
  var clockAt = 0;
  var durMs = 0;
  var seeking = false;

  var rafId = 0;
  var reduced = false;
  var lowfx = false;
  var fps = { frames: 0, since: 0, last: 0, done: false };
  var ringBars = [];

  // 本地时钟每帧的间隔，用来把 lerp 归一化，掉帧时滚动速度不会变慢
  var lastFrameAt = 0;
  var lastDt = 16.7;
  // 抗回退：只有位置真的退回 1.5s 以上才认账（那是用户 seek），否则维持当前行
  var ROLLBACK_TOL_MS = 1500;
  var guardPos = -1;

  // -------------------------------------------------------------------------
  // 可调参数
  // --------------------------------------------------------------------------
  // JS 只保留**必须参与运算**的量：锚点比例、阻尼系数、滚动让位时长、衰减
  // 窗口、瞬落阈值。透明度/缩放/模糊/景深/错峰这些纯视觉量全部在 stage.css
  // 里由 --row-d 算出来，JS 一行都不写。想临时改样式走 Stage.tune()，
  // 想永久改直接编辑 stage.css 的 :root。
  var tune = {
    anchorRatio: 0.382,
    lerp: 0.12,
    scrollIdleMs: 3500,
    // 衰减窗口：只给当前行左右各这么多行写 --row-d，其余靠 CSS 的初始值
    // （也就是最暗的那一档）。长歌词几百行时，这个窗口把每帧的写入量从
    // O(全篇) 压成 O(1)。
    dimWindow: 7,
    // 一次跳变跨过这么多行就瞬落，不逐帧追：拖动进度条时指针已经落在
    // 几十行之外，让滚动慢慢爬过去只会糊成一片
    snapSpan: 3,
    // 行过渡时长的四个约束，见 enterMs()。默认值照「正常一句 2–4s」定的：
    // 那种句子会拿到 500ms 的满档过渡，而 150ms 的短句被压到 90ms。
    enterMs: 500,
    enterFloorMs: 220,
    enterScale: 0.34,
    enterRatio: 0.6,
    microMs: 100
  };

  function readTune() {
    var cs = getComputedStyle(document.documentElement);
    function num(name, dflt) {
      var v = parseFloat(cs.getPropertyValue(name));
      return (typeof v === 'number' && isFinite(v)) ? v : dflt;
    }
    tune.anchorRatio = num('--lyric-anchor-ratio', 0.382);
    tune.lerp = num('--lyric-scroll-lerp', 0.12);
    tune.scrollIdleMs = num('--lyric-scroll-idle-ms', 3500);
    tune.dimWindow = num('--lyric-dim-window', 7);
    tune.snapSpan = num('--lyric-snap-span', 3);
    tune.enterMs = num('--lyric-enter-ms', 500);
    tune.enterFloorMs = num('--lyric-enter-floor-ms', 220);
    tune.enterScale = num('--lyric-enter-scale', 0.34);
    tune.enterRatio = num('--lyric-enter-ratio', 0.6);
    tune.microMs = num('--lyric-micro-ms', 100);
    // lerp 必须在 (0,1) 开区间里：0 等于永远不动，1 等于瞬间跳到目标
    if (tune.lerp <= 0) tune.lerp = 0.001;
    if (tune.lerp >= 1) tune.lerp = 0.999;
    if (tune.anchorRatio < 0) tune.anchorRatio = 0;
    if (tune.anchorRatio > 1) tune.anchorRatio = 1;
    if (tune.dimWindow < 1) tune.dimWindow = 1;
    if (tune.snapSpan < 2) tune.snapSpan = 2;
    // 上限被调到地板以下时（驾驶舱里拖一下就会这样），取夹完的值不能再回头
    // 放大，所以这里把地板压到上限之下，而不是让 enterMs() 产出矛盾结果。
    if (tune.enterMs < 0) tune.enterMs = 0;
    if (tune.enterFloorMs > tune.enterMs) tune.enterFloorMs = tune.enterMs;
    if (tune.enterScale < 0) tune.enterScale = 0;
    if (tune.enterRatio < 0) tune.enterRatio = 0;
    if (tune.enterRatio > 1) tune.enterRatio = 1;
    if (tune.microMs < 0) tune.microMs = 0;
  }

  function $(id) { return document.getElementById(id); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  // -------------------------------------------------------------------------
  // 位置：快照 + 本地插值
  // -------------------------------------------------------------------------

  function currentPos() {
    var p = playing ? basePos + (now() - clockAt) : basePos;
    if (durMs && p > durMs) p = durMs;
    return p < 0 ? 0 : p;
  }

  // -------------------------------------------------------------------------
  // 逐词切分
  // -------------------------------------------------------------------------
  //
  // 卡拉OK 的逐字擦除和心象模式的散开都需要"行被切成 token"。enhanced LRC
  // 自带词级时间轴就直接用；普通 LRC 没有，就按字符权重把行时长摊开造一份。
  // 这一步顺带补上一个长期缺口：普通 LRC 以前整行一起亮，现在也能逐字擦。

  var CJK = /[⺀-〿㐀-䶿一-鿿豈-﫿︰-﹏ｦ-ﾟ]/;

  // 用 Array.from 而不是索引循环：扩展汉字是代理对，按 code unit 切会把一个字
  // 拆成两半，渲染出来就是两个乱码方块。
  function tokenize(text) {
    var out = [];
    var cur = '';
    Array.from(String(text || '')).forEach(function (ch) {
      if (CJK.test(ch)) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(ch);
      } else if (ch === ' ' || ch === '	' || ch === '　') {
        if (cur) { out.push(cur); cur = ''; }
        cur = ch;
      } else {
        cur += ch;
      }
    });
    if (cur) out.push(cur);
    return out.filter(function (t) { return t.length && t !== ' '; });
  }

  function tokenWeight(t) {
    // 拉丁词按长度折算：一个六字母的词读起来大约相当于三个汉字的时长
    return CJK.test(t.charAt(0)) ? 1 : Math.max(1, t.length / 2);
  }

  function tokensFor(line) {
    if (line._tokens) return line._tokens;
    var toks;
    if (line.words && line.words.length) {
      toks = line.words.map(function (w) {
        return { text: w.text, start_ms: w.start_ms, end_ms: w.end_ms };
      });
    } else {
      var parts = tokenize(line.text);
      var total = 0;
      parts.forEach(function (t) { total += tokenWeight(t); });
      var dur = line.end_ms != null ? line.end_ms - line.start_ms : 0;
      if (!(dur > 120)) dur = 3000;              // 脏时长：给个读得完的兜底
      var acc = 0;
      toks = parts.map(function (t) {
        var from = line.start_ms + dur * (acc / (total || 1));
        acc += tokenWeight(t);
        return {
          text: t,
          start_ms: from,
          end_ms: line.start_ms + dur * (acc / (total || 1))
        };
      });
    }
    line._tokens = toks;
    return toks;
  }

  // 这一行实际能唱多久：下一行的起点减去本行起点。末行没有下一行可参照，
  // 就退回它自己带的 end_ms；两个都没有时按上限算，等于"不压缩过渡"。
  function lineSpan(lines, i) {
    var line = lines[i];
    var next = lines[i + 1];
    if (next) return next.start_ms - line.start_ms;
    if (line.end_ms != null) return line.end_ms - line.start_ms;
    return tune.enterMs;
  }

  // 行长 → 这一行的过渡时长。三个约束叠在一起：
  //   1. 短于 microMs 的行直接给 0：那种行是噪声，过渡只会让它糊成一团；
  //   2. 不低于 enterFloorMs，否则一个字根本来不及被看见；
  //   3. 不超过整行时长的 enterRatio——过渡比它服务的对象还长，就等于没有过渡。
  // 取完再被 enterMs（上限）夹一次，长句不会一路放飞。
  function enterMs(span) {
    if (!(span > tune.microMs)) return 0;
    var ms = span * tune.enterScale;
    if (ms < tune.enterFloorMs) ms = tune.enterFloorMs;
    if (ms > tune.enterMs) ms = tune.enterMs;
    var limit = span * tune.enterRatio;
    return ms > limit ? limit : ms;
  }

  // 确定性伪随机：同一个 (行, 词) 每次渲染都落在同一个位置。用 Math.random 的
  // 话，任何一次重排（换主题、改字号、resize 触发 rebuild）都会让整版字重新
  // 洗牌，看起来像 bug 而不是效果。
  function hash2(a, b, k) {
    var x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // -------------------------------------------------------------------------
  // 歌词视图
  // -------------------------------------------------------------------------

  function createView(container, big) {
    var view = { container: container, track: null, nodes: [], big: !!big, empty: null };
    // 缓存几何：box = 可视高度，lo/hi = 允许的位移区间（首行/末行停在锚点）
    view.box = 0;
    view.lo = 0;
    view.hi = 0;
    // 上一轮 --row-d 写到哪一段了，用来回收掉出窗口的元素
    view.dimLo = 1;
    view.dimHi = -1;
    // 行内进度的单调基准：progIdx 变了才重新取值
    view.progIdx = -1;
    view.progVal = 0;
    // 上一帧渲染到 DOM 上的当前行，markRows 靠它算出「只改了哪几行」
    view.shownIdx = -1;

    // 滚动不走原生 scrollTop：容器只裁剪，真正的位移由 JS 写 track 的
    // translate3d。这样浏览器的平滑滚动不会和每帧的位置更新互相打断。
    //
    // 全屏页多包一层 .lp-scene 作为 3D 场景：容器负责 overflow 裁剪，场景负责
    // preserve-3d 与视角旋转。两者必须分开——规范里 overflow 非 visible 会把
    // 同一元素上的 transform-style: preserve-3d 强制压平成 flat，写在同一个
    // 节点上的话每行的 translateZ 就全部失效、旋转只剩一块倾斜的平面。
    if (container) {
      // index.html 里留了一颗静态的 .hint 占位，滚动轨道必须接管之前先把它
      // 清掉，否则歌词会和占位一起留在容器里。
      container.textContent = '';
      view.track = document.createElement('div');
      view.track.className = big ? 'lp-track' : 'lyric-track';
      if (big) {
        view.scene = document.createElement('div');
        view.scene.className = 'lp-scene';
        // 歌词轨单独包一层负责 overflow 裁剪与上下渐隐 mask：这两件事都不能
        // 写在 .lp-scene 上（会把 preserve-3d 压平），也不能留在 .lp-body 上
        // ——全屏粒子背景（.lp-cover.gl-active）要溢出 body、铺满整个视口，
        // body 的裁剪和 mask 会把它切掉。歌词的裁剪收进这一层，背景就自由了。
        var trackClip = document.createElement('div');
        trackClip.className = 'lp-track-clip';
        view.scene.appendChild(buildCover());
        trackClip.appendChild(view.track);
        view.scene.appendChild(trackClip);
        container.appendChild(view.scene);
      } else {
        view.scene = null;
        container.appendChild(view.track);
      }
    }

    // 3D 视角状态。tilt 是用户拖出来的，drift 是自动漂移叠上去的，
    // 分开存才能做到"拖拽时漂移让位、松手一会儿后再接上"而不跳变。
    view.tiltX = 0;
    view.tiltY = 0;
    view.dragId = -1;
    view.dragFrom = null;
    view.lastInputAt = 0;

    // 滚动物理状态：current 是当前位移，target 是本帧算出的目标位移
    view.scrollY = 0;
    view.scrollTarget = 0;
    view.userScrolling = false;
    view.userScrollTimer = 0;

    // 用户手动拨动后让位；静止 lyric-scroll-idle-ms 毫秒再恢复自动跟随。
    if (container) {
      var yieldToUser = function () {
        view.userScrolling = true;
        if (view.userScrollTimer) clearTimeout(view.userScrollTimer);
        view.userScrollTimer = setTimeout(function () { view.userScrolling = false; }, tune.scrollIdleMs);
      };
      // 滚轮直接按增量累加：改写 scrollY 的同时同步 target，让自动跟随从
      // "用户停手的位置"接着走，而不是恢复的瞬间把它猛地抢回去。
      container.addEventListener('wheel', function (e) {
        if (!view.track) return;
        yieldToUser();
        view.scrollY = view.clamp(view.scrollY + e.deltaY);
        view.scrollTarget = view.scrollY;
        view.track.style.transform = 'translate3d(0, ' + (-view.scrollY).toFixed(2) + 'px, 0)';
      }, { passive: true });

      // 触摸拖拽只给全屏页：侧栏是普通文档流，把手势留给页面滚动更自然；
      // 全屏页自己就是整屏，没有"外层滚动"可让。
      if (big) {
        var touchY = 0;
        container.addEventListener('touchstart', function (e) {
          touchY = e.touches[0] ? e.touches[0].clientY : 0;
          yieldToUser();
        }, { passive: true });
        container.addEventListener('touchmove', function (e) {
          if (!view.track || !e.touches[0]) return;
          var y = e.touches[0].clientY;
          yieldToUser();
          view.scrollY = view.clamp(view.scrollY + (touchY - y));
          view.scrollTarget = view.scrollY;
          touchY = y;
          view.track.style.transform = 'translate3d(0, ' + (-view.scrollY).toFixed(2) + 'px, 0)';
        }, { passive: true });
      }
    }

    // 行几何缓存。
    //
    // 全部用布局值（offsetTop / offsetHeight），一个 getBoundingClientRect 都不用：
    // 轨道和行都挂着 CSS transition，rect 读到的是**过渡过程中的**位移，
    // 而 measure() 恰恰只在换行那一刻跑，于是缓存里永远带着一两个像素的
    // 滞后偏差——量一次错一次，还会自以为是地当成新基准。
    //
    // 两层 offsetTop 正好接得上：容器（.stage-lyrics / .lp-body）本来就是
    // position: relative，轨道因为 will-change 成了行的 offsetParent，
    // 所以 top(i) = 轨道在容器里的位置 + 行在轨道里的位置，与滚动无关。
    //
    // 这些都是会强制回流的读量，所以只在三个时点量：建轨道、换行
    // （.active 改字重会改行高）、容器尺寸变化。
    view.measure = function () {
      var cont = view.container;
      if (!view.track || !cont.clientHeight) return false;
      var nodes = view.nodes;
      view.box = cont.clientHeight;
      if (!nodes.length) { view.lo = 0; view.hi = 0; return true; }
      // 有场景层时轨道的 offsetParent 变成场景（它带 transform），所以要两段
      // 一起加。都是布局值，不含 transform，所以视角怎么转都不影响量出来的行位。
      var base = (view.scene ? view.scene.offsetTop : 0) + view.track.offsetTop;
      for (var i = 0; i < nodes.length; i += 1) {
        nodes[i].top = base + nodes[i].el.offsetTop;
        nodes[i].h = nodes[i].el.offsetHeight;
      }
      // 上下界就是「首行停在锚点」和「末行停在锚点」两个位移，允许为负。
      // 不这么做的后果很具体：长歌词的前半段目标位移全被 clamp 成 0，
      // 当前行一直停在视口上方看不见，直到歌过半程才突然跳出来。
      var anchor = view.box * tune.anchorRatio;
      view.lo = nodes[0].top + nodes[0].h / 2 - anchor;
      view.hi = nodes[nodes.length - 1].top + nodes[nodes.length - 1].h / 2 - anchor;
      if (view.hi < view.lo) view.hi = view.lo;   // 只有一行：没有可滚动的余地
      return true;
    };

    view.clamp = function (v) {
      return clamp(v, view.lo || 0, view.hi || 0);
    };

    view.build = function (d) {
      view.nodes = [];
      view.empty = null;
      view.scrollY = 0;
      view.scrollTarget = 0;
      view.dimLo = 1;
      view.dimHi = -1;
      view.progIdx = -1;
      // 轨道是整棵重建的，DOM 上没有任何状态类了，基准要跟着归零，
      // 否则 markRows 会以为上一帧还亮着旧轨道里的那一行
      view.shownIdx = -1;
      if (!view.track) return;
      view.track.textContent = '';
      view.track.classList.remove('pre');
      // 轨道元素是复用的：scrollY 已经归零，上一次的 translate 也必须一起
      // 清掉，否则 DOM 停在旧位置而逻辑认为在 0，第一帧的滚动会跳一下。
      view.track.style.transform = 'translate3d(0, 0, 0)';
      if (!d || !d.lines || !d.lines.length) {
        var hint = document.createElement('div');
        hint.className = 'lyric-empty';
        hint.textContent = '这首歌没有可用歌词';
        view.track.appendChild(hint);
        view.empty = hint;
        return;
      }
      d.lines.forEach(function (line, i) {
        var node = document.createElement('div');
        // 全屏页同时挂 lp-line：那一套字号/字重/过渡是给大尺寸排版的，
        // 舞台里的小字走 .lyric。两个类同名属性由 stage.css 的顺序决定胜负。
        node.className = big ? 'lyric lp-line' : 'lyric';
        var toks = tokensFor(line);
        var words = null;
        if (toks.length > 1) {
          var wrap = document.createElement('span');
          wrap.className = 'lyric-words';
          toks.forEach(function (w, k) {
            var s = document.createElement('span');
            s.className = 'word';
            s.textContent = w.text;
            // 心象模式的散开量在构建时一次算完写成变量：它不随时间变，
            // 没有理由在每帧重算。
            s.style.setProperty('--w-dx', ((hash2(i, k, 1) - 0.5) * 2).toFixed(3));
            s.style.setProperty('--w-dy', ((hash2(i, k, 2) - 0.5) * 2).toFixed(3));
            s.style.setProperty('--w-rot', ((hash2(i, k, 3) - 0.5) * 2).toFixed(3));
            // 字号上限 68px 时，1.6 倍的字（110px）比"字宽 + 字间距"的排布
            // 周期（约 91px）还宽，光靠缩放就会压到邻居 —— 所以这一档必须收窄。
            s.style.setProperty('--w-sc', (0.9 + hash2(i, k, 4) * 0.22).toFixed(3));
            // 浮动的周期（秒）。每个字都不一样：一行里所有字同步上下挪，
            // 读起来像一整张贴图在抖；相位错开才像每个字自己活着。
            s.style.setProperty('--w-fl', (2.8 + hash2(i, k, 5) * 1.8).toFixed(2));
            wrap.appendChild(s);
          });
          node.appendChild(wrap);
          words = Array.prototype.slice.call(wrap.children);
        } else {
          node.textContent = line.text;
        }
        // 点歌词跳转：一行歌词就是一个可点击的锚点。顺手解除手动滚动，
        // 否则点了半天视口不跟回去，会让人以为没生效。
        node.addEventListener('click', function () {
          // 拖视角时指针也会扫过行，不拦一下会在转完头的瞬间跳歌
          if (container._justDragged) return;
          view.userScrolling = false;
          if (view.userScrollTimer) clearTimeout(view.userScrollTimer);
          emit('seek', line.start_ms);
        });
        // 每一行自带过渡时长。一句只唱 150ms 的 ad-lib 如果套着 500ms 的入场
        // 过渡，永远到不了目标状态——看起来就是"这行没亮起来"。这个量由行长
        // 决定，是静态的，所以构建时写一次，之后每帧不再碰。
        node.style.setProperty('--line-ms', enterMs(lineSpan(d.lines, i)) + 'ms');
        view.track.appendChild(node);
        view.nodes.push({ el: node, words: words, line: line, idx: i, top: 0, h: 0 });
      });
      view.measure();
    };

    // 目标位移：不是"把当前行顶到中线"，而是在当前行与下一行之间按行内
    // 进度插值——于是行与行之间匀速漂移，而不是每到换行走一次突变。
    view.aim = function (idx, pos) {
      if (!view.track || view.userScrolling) return;
      if (!view.box) return;                      // 容器被隐藏，量不准
      if (idx < 0) { view.scrollTarget = view.lo; return; } // 还没进第一段歌词
      var cur = view.nodes[idx];
      if (!cur) return;
      var nxt = view.nodes[idx + 1];
      var from = cur.top;
      var to = nxt ? nxt.top : from;

      var raw = 0;
      if (nxt) {
        var span = nxt.line.start_ms - cur.line.start_ms;
        // 两行挨太近（Enhanced LRC 常见）时跳过插值，否则会算出跳变
        if (span > 300) raw = clamp01((pos - cur.line.start_ms) / span);
      }
      // smoothstep：行内缓进缓出，只有行与行的交界处才接近匀速
      var p = raw * raw * (3 - 2 * raw);
      // 同一行内单调不回退。快照校正带来的几十毫秒位置回拨不该让整版歌词
      // 跟着抖一下；真要往回走得靠换行——progIdx 变了才会重新取基准。
      if (idx === view.progIdx) p = Math.max(p, view.progVal);
      else { view.progIdx = idx; view.progVal = p; }

      var offset = from + (to - from) * p;
      view.scrollTarget = clamp(offset + cur.h / 2 - view.box * tune.anchorRatio,
        view.lo, view.hi);
    };

    // 逐帧阻尼逼近：本项目用的是简单 lerp（带 dt 归一化），比固定步长在
    // 掉帧时更稳；tune.lerp 即每 16.7ms 逼近的比例。
    view.step = function (dtMs) {
      if (!view.track || view.userScrolling) return;
      if (Math.abs(view.scrollTarget - view.scrollY) < 0.01) return;
      var k = clamp01(1 - Math.pow(1 - tune.lerp, Math.max(0.2, dtMs / 16.7)));
      var next = view.scrollY + (view.scrollTarget - view.scrollY) * k;
      if (Math.abs(view.scrollTarget - next) < 0.05) next = view.scrollTarget;
      view.scrollY = next;
      view.track.style.transform = 'translate3d(0, ' + (-view.scrollY).toFixed(2) + 'px, 0)';
    };

    // 直接落位，不走动画：切歌、开全屏页、改窗口尺寸时用。
    view.jump = function () {
      if (!view.track) return;
      view.scrollY = view.scrollTarget;
      view.track.style.transform = 'translate3d(0, ' + (-view.scrollY).toFixed(2) + 'px, 0)';
    };

    // 距离衰减：JS 只告诉 CSS「这一行离当前行多远、在哪一侧」，透明度、缩放、
    // 景深、模糊、错峰全部由 stage.css 从 --row-d 算出来。
    //
    // 两点让它比"每帧遍历全篇写 opacity + filter"便宜：
    //   1) 只处理当前行左右 dimWindow 行以内的元素，掉出窗口的把内联变量摘掉，
    //      交给 .lyric 里 --row-d 的初始值自动坐落到最暗一档；
    //   2) 距离没变就不写。整首歌里单个元素被写的次数约等于 2×dimWindow，
    //      而不是每帧一次。
    view.dim = function (idx) {
      if (!view.track) return;
      var lo, hi;
      if (idx < 0) { lo = 1; hi = 0; }             // 前奏：整条走 .pre，一律不衰减
      else {
        lo = Math.max(0, idx - tune.dimWindow);
        hi = Math.min(view.nodes.length - 1, idx + tune.dimWindow);
      }
      for (var k = view.dimLo; k <= view.dimHi; k += 1) {
        if (k >= lo && k <= hi) continue;
        var out = view.nodes[k];
        if (out && out.el._rd !== undefined) {
          out.el.style.removeProperty('--row-d');
          out.el.style.removeProperty('--row-dir');
          out.el._rd = undefined;
        }
      }
      for (var i = lo; i <= hi; i += 1) {
        var node = view.nodes[i];
        if (!node) continue;
        var d = i - idx;
        var abs = d < 0 ? -d : d;
        if (node.el._rd === abs) continue;
        node.el._rd = abs;
        node.el.style.setProperty('--row-d', abs);
        node.el.style.setProperty('--row-dir', d < 0 ? -1 : (d > 0 ? 1 : 0));
      }
      view.dimLo = lo;
      view.dimHi = hi;
      view.track.classList.toggle('pre', idx < 0);
    };

    return view;
  }

  // -------------------------------------------------------------------------
  // 舞台封面盘
  // -------------------------------------------------------------------------
  //
  // 挂进 .lp-scene 而不是另起一层：这样它和歌词共用同一个 perspective 与用户
  // 拖出来的 --lp-rx/--lp-ry，转歌词就是转封面，不需要第二次同步两个角度。
  //
  // 旋转本身是 CSS 动画（stage.css 的 lp-cover-turn），律动呼吸直接消费
  // 已有的 --stage-energy。所以这个子系统在 JS 侧一个帧门都不占、每帧零写入
  // ——换封面时才动一次 DOM。
  var cover = { on: false, node: null, front: null, back: null };

  function buildCover() {
    var node = document.createElement('div');
    node.className = 'lp-cover';
    // 纯装饰：屏幕阅读器不该播报"图片"，曲目名和艺术家在标题区已经念过了。
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML =
      '<div class="lp-cover-spin">' +
        '<div class="lp-cover-face lp-cover-front"><img alt="" decoding="async"></div>' +
        '<div class="lp-cover-face lp-cover-back"><img alt="" decoding="async"></div>' +
      '</div>';
    cover.node = node;
    var imgs = node.getElementsByTagName('img');
    cover.front = imgs[0];
    cover.back = imgs[1];
    return node;
  }

  // 背景粒子层是否真的可用：场景与对应子模块都就绪才算数
  function particleBackgroundOn() {
    if (!cover.on) return false;
    if (scene === 'cover') {
      return !!(window.StageCoverParticles && StageCoverParticles.active());
    }
    if (scene === 'starriver') {
      return !!(window.StageStarRiver && StageStarRiver.active());
    }
    return false;
  }

  function paintCover() {
    if (!cover.node || !el.page) return;
    // 图片地址只跟着曲目，显不显示只跟着开关：两者混在一个 url 里的话，关一下
    // 再开会把 src 摘掉又挂回去，白白重新解码两张 640px 的图。
    var url = lastCover || '';

    // 背景场景三态分流：cover 粒子专辑封面 / starriver 星河；任一粒子层生效时
    // has-particles 隐藏 CSS 旋转卡片
    el.page.classList.toggle('has-cover',
      !!(cover.on && scene === 'cover' && url));
    el.page.classList.toggle('has-starriver',
      !!(cover.on && scene === 'starriver'));
    el.page.classList.toggle('has-particles', particleBackgroundOn());
    // 共享 GL 画布只在某个粒子场景真正生效时可见
    cover.node.classList.toggle('gl-active', particleBackgroundOn());

    [cover.front, cover.back].forEach(function (img) {
      if (!img) return;
      // 同一个 URL 不重设：换主题 / retint 也会再走一遍这里。
      if (url) { if (img.getAttribute('src') !== url) img.setAttribute('src', url); }
      else if (img.hasAttribute('src')) img.removeAttribute('src');
    });
    syncCoverBtn();
    syncSceneBtns();
  }

  function syncCoverBtn() {
    var btn = $('lp-cover');
    if (!btn) return;
    var label = cover.on ? '隐藏舞台封面' : '显示舞台封面';
    btn.classList.toggle('active', cover.on);
    btn.setAttribute('aria-pressed', String(cover.on));
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    // 开着但当前曲目没有封面图：给按钮上一个"暂无内容"的暗态。不禁用——
    // 模式留着，切到下一首有封面的歌自己就出来了。
    btn.classList.toggle('is-void', cover.on && !lastCover);
  }

  function setCover(next, opts) {
    cover.on = !!next;
    paintCover();
    if (!(opts && opts.silent)) emit('cover', cover.on);
  }

  // -------------------------------------------------------------------------
  // 背景场景：粒子封面 / 星河
  // -------------------------------------------------------------------------

  function syncSceneBtns() {
    // 全屏页头部的背景切换组
    if (el.sceneBtns) {
      Array.prototype.forEach.call(el.sceneBtns.children, function (b) {
        var on = b.getAttribute('data-scene') === scene && cover.on;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    // 侧栏舞台模式条上的星河按钮：仅在全屏星河场景时高亮
    var sbStar = $('mode-starriver');
    if (sbStar) {
      var sbOn = isPageOpen() && scene === 'starriver' && cover.on;
      sbStar.classList.toggle('active', sbOn);
      sbStar.setAttribute('aria-pressed', String(sbOn));
    }
  }

  function setScene(next, opts) {
    if (SCENES.indexOf(next) < 0) next = 'cover';
    if (scene === next && !(opts && opts.force)) {
      // 已在该场景：当作"关掉背景总开关"
      if (cover.on) setCover(false);
      return;
    }
    scene = next;
    try { localStorage.setItem(SCENE_KEY, scene); } catch (e) { /* 隐私模式 */ }
    if (!cover.on) setCover(true, { silent: true });
    else paintCover();
    schedule();
  }

  // -------------------------------------------------------------------------
  // 自动 360° 环转
  // -------------------------------------------------------------------------

  function setAutoSpin(next, opts) {
    autoSpin = (next === undefined) ? !autoSpin : !!next;
    try { localStorage.setItem(SPIN_KEY, autoSpin ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
    var btn = $('lp-autospin');
    if (btn) {
      btn.classList.toggle('active', autoSpin);
      btn.setAttribute('aria-pressed', String(autoSpin));
      var label = autoSpin ? '停止自动旋转' : '自动 360° 旋转';
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
    }
    if (!(opts && opts.silent)) schedule();
  }

  // -------------------------------------------------------------------------
  // 全屏舞台的 3D 视角
  // -------------------------------------------------------------------------
  //
  // 用 CSS 3D 而不是 WebGL：歌词是文字，留在 DOM 里才能保住清晰度、字体回退、
  // 点击跳转和屏幕阅读器。WebGL 要拿到同样的文字清晰度得把每行栅格化成贴图，
  // 换一次字号就重栅一次——那正是 Mineradio 为歌词写了 3200 行调度代码的原因，
  // 不是我们需要的复杂度。
  //
  // 让旋转"看起来是 3D"的不是容器转了一下，而是每行按离当前行的距离
  // translateZ 到不同深度上（见 stage.css 的 --lyric-row-depth）。于是转起来
  // 近的行位移多、远的位移多，行与行之间产生视差；否则整块文字只是斜了一下。

  // 360° 视角：拖拽角度不再设上限，可以连续转满整圈。tilt.max 只剩一个用途——
  // 驾驶舱 UI 的语义保留；自动漂移是小幅摆动，自动环转才做 360。
  var tilt = { max: 26, resumeMs: 1400, drift: 1, enabled: true };

  function readTilt() {
    var cs = getComputedStyle(document.documentElement);
    function num(name, dflt) {
      var v = parseFloat(cs.getPropertyValue(name));
      return (typeof v === 'number' && isFinite(v)) ? v : dflt;
    }
    tilt.max = num('--lp-tilt-max', 26);
    tilt.resumeMs = num('--lp-drift-resume-ms', 1400);
    tilt.drift = num('--lp-drift', 1);
    tilt.enabled = cs.getPropertyValue('--lp-3d').trim() !== 'off';
  }

  // writeTilt 每帧由歌词门调用；dtMs 用来把自动环转的角速度换算成增量
  function writeTilt(view, dtMs) {
    if (!view.scene) return;
    var t = now();
    var rx = view.tiltX;
    var ry = view.tiltY;

    // 自动 360 环转：仅全屏页、未拖拽、未要求减少动效时推进。增量直接写回
    // tiltY，用户此刻抓指针拖拽会从当前真实角度接手，不会跳回环转起点。
    if (autoSpin && view.big && view.dragId < 0 && !reduced) {
      view.tiltY += SPIN_DEG_PER_SEC * Math.max(0.001, dtMs || lastDt) / 1000;
      ry = view.tiltY;
    }

    // 自动漂移在用户刚操作过的那段时间里让位，否则手刚松开就被拽回去。
    // 环转开启时漂移关掉，避免两种自动运动叠加。
    var idle = t - view.lastInputAt > tilt.resumeMs;
    if (!autoSpin) {
      var d = (idle && tilt.drift > 0 && !reduced)
        ? Math.sin(t / 5200) * 3.4 * tilt.drift
        : 0;
      rx += d * 0.6;
      ry += d;
    }

    if (view._rx === rx && view._ry === ry) return;
    view._rx = rx;
    view._ry = ry;
    view.scene.style.setProperty('--lp-rx', rx.toFixed(2) + 'deg');
    view.scene.style.setProperty('--lp-ry', ry.toFixed(2) + 'deg');
  }

  function resetTilt(view) {
    view.tiltX = 0;
    view.tiltY = 0;
    view.lastInputAt = now();
    writeTilt(view);
  }

  // 拖拽只负责改角度，不碰滚动：纵向手势仍然归滚轮/触摸板（那是翻歌词的），
  // 所以这里要求按住指针才转，且超过阈值后抑制"点一行跳转"的点击。
  function bindTiltDrag(view) {
    var el = view.container;
    if (!el || !view.scene) return;

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || view.dragId >= 0) return;
      view.dragId = e.pointerId;
      view.dragFrom = { x: e.clientX, y: e.clientY, tx: view.tiltX, ty: view.tiltY, moved: 0 };
      view.lastInputAt = now();
    });

    el.addEventListener('pointermove', function (e) {
      if (e.pointerId !== view.dragId || !view.dragFrom) return;
      var dx = e.clientX - view.dragFrom.x;
      var dy = e.clientY - view.dragFrom.y;
      view.dragFrom.moved = Math.max(view.dragFrom.moved, Math.abs(dx) + Math.abs(dy));
      if (view.dragFrom.moved < 8) return;         // 8px 以内当点击，不误伤跳转
      // 横向拖 = 绕 Y，纵向拖 = 绕 X；除以 4 大致是"拖 4px 转 1°"的手感。
      // 角度不夹：拖满一圈就是 360°，连续拖可以转到任意角度
      view.tiltY = view.dragFrom.ty + dx / 4;
      view.tiltX = view.dragFrom.tx - dy / 4;
      view.lastInputAt = now();
      // 直接操作不能等帧门：eco 档歌词只有 24fps，拖一下要 40ms 才回应，
      // 手感上就是"粘"。漂移那种低频运动才交给 tick 去节流。
      writeTilt(view);
      if (e.cancelable) e.preventDefault();
    });

    function end(e) {
      if (e.pointerId !== view.dragId) return;
      view.dragId = -1;
      view.lastInputAt = now();
      // 把 moved 挂到容器上，供行的 click 处理器判断"这一下其实是拖拽"
      el._justDragged = view.dragFrom && view.dragFrom.moved >= 8;
      view.dragFrom = null;
      if (el._justDragged) setTimeout(function () { el._justDragged = false }, 0);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', function () { resetTilt(view); });
    // 触摸板上双指平移更顺手，给键盘用户留一条路
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', function (e) {
      var k = e.key === 'ArrowLeft' ? -3 : e.key === 'ArrowRight' ? 3 : 0;
      // 纵向也给键盘：Alt+↑/↓ 各 3°
      var kx = e.key === 'ArrowUp' ? -3 : e.key === 'ArrowDown' ? 3 : 0;
      if ((!k && !kx) || !e.altKey) return;
      view.tiltY += k;
      view.tiltX += kx;
      view.lastInputAt = now();
      writeTilt(view);
      e.preventDefault();
    });
  }

  // 位置 → 行号。d.lines 按 start_ms 升序，命中最后一个 start <= pos 的行。
  // 用二分而不是顺序扫：这个查询每帧都要做，长歌词（几百行、还带逐字时间轴）
  // 顺序扫是纯浪费；二分还有个附带好处——seek 之后不需要回退游标，天然自愈。
  function rawIndex(d, pos) {
    var lines = d.lines;
    var lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].start_ms <= pos) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }

  // 抗回退包裹：本地时钟偶尔会小幅回拨（WS 快照校正、seek 落地的抖动），
  // 这时候已经点亮的行不该跟着闪回去。只有位置真的退回 1.5s 以上——那是用户
  // 拖回去了——才认账。
  function resolveIndex(d, pos) {
    var i = rawIndex(d, pos);
    if (guardPos >= 0 && i < activeIdx && pos > guardPos - ROLLBACK_TOL_MS) return activeIdx;
    guardPos = pos;
    return i;
  }

  // 逐字染色：--word-progress 驱动 background-clip:text 的渐变截断位置，
  // 类名驱动正在唱 / 已唱完两种状态（放大、发光、回落）。
  function paintWords(node, pos) {
    if (!node.words) return;
    var toks = tokensFor(node.line);
    for (var i = 0; i < node.words.length; i += 1) {
      var w = toks[i];
      if (!w) continue;
      // 词是按时间升序的，一旦碰到还没起唱、而且本来就没动过的词，后面的
      // 一定也是这个状态，直接收工而不是把整行扫完
      if (pos < w.start_ms) { if (node.words[i]._wp === 0) break; }
      var el2 = node.words[i];
      // 已经唱完的词不必再算：染色停在 100%、类名停在 finished
      if (el2._st === 2 && el2._wp === 100) continue;
      var end = w.end_ms ||
        (toks[i + 1] ? toks[i + 1].start_ms : (node.line.end_ms || w.start_ms + 400));
      var raw = end - w.start_ms;
      if (!isFinite(raw) || raw < 80) raw = 80;      // 脏时间戳：给个最小步长
      var span = Math.min(raw, WORD_CAP_MS);
      var p = clamp01((pos - w.start_ms) / span);
      // 量化到 0.5% 再写：渐变截断位置肉眼看不出半格以下的差别，但每帧照抄
      // 一遍 style 会让元素一直待在失效集里。
      var pct = Math.round(p * 200) / 2;
      if (el2._wp !== pct) {
        el2._wp = pct;
        el2.style.setProperty('--word-progress', pct + '%');
      }
      // 只在起唱 / 唱完的边界上动类名，避免每帧 classList 抖动
      var state = pos < w.start_ms ? 0 : (p >= 1 ? 2 : 1);
      if (el2._st !== state) {
        el2.classList.toggle('singing', state === 1);
        el2.classList.toggle('finished', state === 2);
        el2._st = state;
      }
    }
  }

  function resetWords(node) {
    if (!node.words) return;
    for (var i = 0; i < node.words.length; i += 1) {
      var w = node.words[i];
      if (w._wp !== 0) { w._wp = 0; w.style.setProperty('--word-progress', '0%'); }
      if (w._st !== 0) {
        w.classList.remove('singing', 'finished');
        w._st = 0;
      }
    }
  }

  // 只刷「变了的那几行」。换行时真正需要动的元素是：下放的旧当前行、新当前行，
  // 以及两个索引之间那一段的 past 位——而不是像以前那样遍历整首歌。
  function markRows(view, idx) {
    var prev = view.shownIdx;
    if (prev === idx) return;
    var nodes = view.nodes;
    if (prev >= 0 && nodes[prev]) {
      nodes[prev].el.classList.remove('active');
      resetWords(nodes[prev]);
    }
    if (idx >= 0 && nodes[idx]) nodes[idx].el.classList.add('active');
    var a, b;
    if (prev < idx) { a = Math.max(0, prev); b = Math.min(idx - 1, nodes.length - 1); }
    else { a = Math.max(0, idx); b = Math.min(Math.max(prev, 0) - 1, nodes.length - 1); }
    for (var i = a; i <= b; i += 1) {
      if (nodes[i]) nodes[i].el.classList.toggle('past', prev < idx);
    }
    view.shownIdx = idx;
  }

  // 每帧一次地把「当前行」这件事刷到所有视图上。动的三样东西：
  //   1) 行状态类（active / past）
  //   2) 滚动目标 → 阻尼推进 → 位移
  //   3) 非当前行的距离衰减（写一个 --row-d，剩下的交给 CSS）
  // snap=true 时跳过动画直接落位，用于切歌、开全屏页、改尺寸。
  function update(idx, pos, snap, changed) {
    if (!doc) return;
    views.forEach(function (view) {
      if (view.empty) return;
      // 先改类再量：--lyric-active-weight 会改行高，量早了拿到的还是旧几何
      if (changed) { markRows(view, idx); view.measure(); }
      view.aim(idx, pos);
      if (snap) view.jump(); else view.step(lastDt);
      view.dim(idx);
      var node = view.nodes[idx];
      if (node) paintWords(node, pos);
    });

    // 全屏页的译文行跟着当前行走
    if (changed && el.lpSub) {
      var tr = doc.translation && doc.translation[idx];
      el.lpSub.textContent = tr || '';
      el.lpSub.hidden = !tr;
    }
  }

  // 尺寸/可见性变了，缓存的行几何全部作废——重量一遍并直接落位。
  //
  // 这里也要把当前行类补上：refresh 会把 activeIdx 推进到新值，如果只改
  // activeIdx 不刷 DOM，下一帧 frame() 算出 changed=false，高亮行就会一直
  // 停在旧的那一行，直到真的换行才纠正过来。
  function refresh(snap) {
    var pos = seeking ? basePos : currentPos();
    var idx = doc ? resolveIndex(doc, pos) : -1;
    var changed = idx !== activeIdx;
    activeIdx = idx;
    views.forEach(function (view) {
      if (!view.track || view.empty) return;
      if (changed) markRows(view, idx);
      view.measure();
      view.aim(idx, pos);
      if (snap) view.jump();
      view.dim(idx);
    });
    return changed;
  }

  // -------------------------------------------------------------------------
  // 取色：从封面里抽一个主色，驱动整个舞台的单色强调
  // -------------------------------------------------------------------------

  function hsl(h, s, l) { return 'hsl(' + Math.round(h) + ' ' + Math.round(s) + '% ' + Math.round(l) + '%)'; }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (!d) return [0, 0, l * 100];
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s * 100, l * 100];
  }

  function applyPalette(h, s) {
    var root = document.documentElement.style;
    var sat = Math.max(28, Math.min(72, s));
    root.setProperty('--stage-h1', hsl(h, sat * 0.66, 30));
    root.setProperty('--stage-h2', hsl(h + 16, sat * 0.55, 11));
    root.setProperty('--stage-h3', hsl(h + 168, sat * 0.5, 24));
    var hi = hsl(h, Math.min(78, sat + 16), 68);
    // 补色那一支是给粒子层做第二色用的。单独再给一份 rgb 三元组，是因为
    // rgba() 的第三个参数位置塞不进 hsl() 字符串——同一个原因见 --*-rgb 那组令牌。
    var alt = hsl(h + 168, Math.min(72, sat + 8), 62);
    root.setProperty('--music-highlight', hi);
    root.setProperty('--music-highlight-rgb', hslToRgbTriplet(hi));
    root.setProperty('--music-highlight-alt', alt);
    root.setProperty('--music-highlight-alt-rgb', hslToRgbTriplet(alt));
    announceRetint();
  }

  function resetPalette() {
    var root = document.documentElement.style;
    ['--stage-h1', '--stage-h2', '--stage-h3',
      '--music-highlight', '--music-highlight-rgb',
      '--music-highlight-alt', '--music-highlight-alt-rgb']
      .forEach(function (k) { root.removeProperty(k); });
    announceRetint();
  }

  // 取色结果落到 CSS 变量之后通知表现层：粒子层要按新色重画光点精灵。
  // 走事件而不是直接调用，是为了让 stage.js 依然不认识任何消费者——
  // 加一层视觉效果不需要回来改这个文件。
  function announceRetint() {
    document.dispatchEvent(new CustomEvent('stage:retint'));
  }

  // hsl() 字符串没法直接塞进 rgba() 的 rgb 三元位，这里用一个离屏像素换算。
  var rgbProbe = null;
  function hslToRgbTriplet(color) {
    try {
      if (!rgbProbe) {
        rgbProbe = document.createElement('canvas');
        rgbProbe.width = 1; rgbProbe.height = 1;
      }
      var g = rgbProbe.getContext('2d');
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = color;
      g.fillRect(0, 0, 1, 1);
      var d = g.getImageData(0, 0, 1, 1).data;
      return d[0] + ', ' + d[1] + ', ' + d[2];
    } catch (e) {
      return '226, 176, 113';
    }
  }

  function extractPalette(url) {
    if (!url) { resetPalette(); return; }
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0, 32, 32);
      var data;
      try { data = g.getImageData(0, 0, 32, 32).data; } catch (e) { resetPalette(); return; }

      // 12 个色相桶，按「饱和度 × 亮度权重」投票；丢掉近黑近白的像素。
      var buckets = new Array(12);
      for (var i = 0; i < 12; i += 1) buckets[i] = { h: 0, s: 0, w: 0 };
      for (var p = 0; p < data.length; p += 4) {
        var r = data[p], gg = data[p + 1], b = data[p + 2];
        var hslv = rgbToHsl(r, gg, b);
        if (hslv[2] < 12 || hslv[2] > 94) continue;
        var weight = (hslv[1] / 100) * (0.3 + 0.7 * (1 - Math.abs(hslv[2] - 55) / 55));
        if (weight < 0.04) continue;
        var bk = buckets[Math.min(11, Math.floor(hslv[0] / 30))];
        bk.h += hslv[0] * weight;
        bk.s += hslv[1] * weight;
        bk.w += weight;
      }
      var best = null;
      for (var k = 0; k < buckets.length; k += 1) {
        if (!best || buckets[k].w > best.w) best = buckets[k];
      }
      if (!best || best.w <= 0) { resetPalette(); return; }
      applyPalette(best.h / best.w, best.s / best.w);
    };
    img.onerror = function () { resetPalette(); };
    img.src = url;
  }

  // -------------------------------------------------------------------------
  // 律动环 + 能量
  // -------------------------------------------------------------------------

  function buildRing(n) {
    if (!el.ring) return;
    el.ring.textContent = '';
    ringBars = [];
    for (var i = 0; i < n; i += 1) {
      var s = document.createElement('span');
      var deg = (360 / n) * i;
      var len = 10 + (i % 3) * 3;
      s.style.height = len + 'px';
      s.style.transform = 'translate(-50%, -50%) rotate(' + deg + 'deg) translateY(-50%)';
      s.style.transformOrigin = '50% 0';
      el.ring.appendChild(s);
      ringBars.push(s);
    }
  }

  // 能量：一阶低通 + 分频写入。
  //
  // 平滑系数按实际间隔归一化。原来写死 0.28 是「每帧 28%」，帧门从 20fps
  // 掉到 10fps 时光晕的响应速度会跟着慢一倍——同一个 tune 值在两台机器上
  // 手感不同，是最难查的那种不一致。
  var energy = 0;

  // 节拍包络：复用全项目唯一的起音检测器（onset.js）。它内置的 pulse 已带
  // attack（起音累加）/ release（decayTau 170ms 指数衰减），这里只做一件事：
  // 乘上用户的律动幅度后量化写出 --beat，由 stage.css 抬动当前行。
  var beatDet = null;
  var beatAmp = 0.8;             // 驾驶舱 beatAmp/100
  var beatShown = 0;

  function stepBeat(dtMs) {
    if (!beatDet) return;
    if (playing && !reduced && spectrum && spectrum.length) {
      beatDet.step(dtMs, spectrum, now());
    } else if (beatDet.pulse > 0.001) {
      // 暂停 / 无频谱时检测器不再推进，补一笔同样的衰减让包络归零
      beatDet.pulse *= Math.exp(-dtMs / 170);
    } else {
      beatDet.pulse = 0;
    }
    var raw = clamp01(beatDet.pulse * beatAmp);
    // 量化到 2%：减少 style 写入与失效集抖动，肉眼分辨不出这个粒度
    var q = Math.round(raw * 50) / 50;
    if (q === beatShown) return;
    beatShown = q;
    document.documentElement.style.setProperty('--beat', q ? q.toFixed(3) : '0');
  }

  function pushEnergy(v, dtMs) {
    var k = 1 - Math.pow(1 - 0.28, Math.max(0.2, (dtMs || 16.7) / 50));
    energy = energy + (clamp01(v) - energy) * k;
  }

  function paintEnergy() {
    var e = energy.toFixed(3);
    var root = document.documentElement.style;
    root.setProperty('--stage-energy', e);
    root.setProperty('--stage-glow', (energy * 0.8).toFixed(3));
    if (lowfx || !ringBars.length) return;
    for (var i = 0; i < ringBars.length; i += 1) {
      var b = ringBars[i];
      var k = 0.6 + Math.sin((i / ringBars.length) * Math.PI * 2 + energy * 6) * 0.4;
      b.style.opacity = (0.25 + energy * k * 0.75).toFixed(3);
      b.style.transform =
        'translate(-50%, -50%) rotate(' + ((360 / ringBars.length) * i) + 'deg) ' +
        'translateY(-50%) scaleY(' + (1 + energy * k * 1.8).toFixed(3) + ')';
    }
  }

  // -------------------------------------------------------------------------
  // 帧循环与分系统帧门
  // -------------------------------------------------------------------------
  //
  // 每个子系统报一个目标帧率，主循环每帧问一次「到点了没有」。到点的那一次
  // 拿到的是**累积**下来的 dt，所以 30fps 的动画不会因为跑在 60Hz 的 rAF 里
  // 就走慢一半。
  //
  // 为什么用帧门而不是降分辨率 / 减元素：帧门只让某一个子系统自己变钝，
  // 而降分辨率会糊到整屏、减元素会让画面凭空少一块。这三层里帧门是唯一
  // 「关掉一个不影响另一个」的开关，所以弱机降级按它来切。
  var gates = [];

  // 设备档位：0 eco / 1 balanced / 2 high。启动时判一次，之后运行期只允许
  // 往下修正。阈值不是拍脑袋：4 核以下跑不动大面积 backdrop-filter，
  // 4.2M 渲染像素以上（约 2560×1600@1x 或 1080p@2x）模糊层的填充率就开始吃帧。
  var tier = 2;
  function detectTier() {
    var cores = navigator.hardwareConcurrency || 8;
    var mem = navigator.deviceMemory || 8;
    var px = (window.innerWidth || 1920) * (window.innerHeight || 1080) *
      Math.min(3, window.devicePixelRatio || 1);
    if (cores <= 2 || mem <= 2) return 0;
    if (cores <= 4 || mem <= 4 || px >= 4.2e6) return 1;
    return 2;
  }

  function defineGate(name, fpsFn, tickFn) {
    gates.push({ name: name, fpsFn: fpsFn, tickFn: tickFn, acc: 0 });
    // 登记一个「此刻就想要帧」的门时必须踢一脚循环：播放状态下循环本来就在转，
    // 但暂停时没有任何别的事件会来启动它（背景墙/视差在暂停时也得渲染）。
    if (fpsFn() > 0) schedule();
  }

  // 注销帧门（子系统销毁时调用）
  function removeGate(name) {
    for (var i = 0; i < gates.length; i += 1) {
      if (gates[i].name === name) { gates.splice(i, 1); break; }
    }
  }

  // 整体销毁：停循环、清帧门。子模块各自的 GL/DOM 资源由自己的 destroy 释放。
  function destroy() {
    gates.length = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function runGates(dt) {
    for (var i = 0; i < gates.length; i += 1) {
      var g = gates[i];
      var target = g.fpsFn();
      if (!(target > 0)) { g.acc = 0; continue; }
      g.acc += dt;
      if (g.acc < 1000 / target) continue;
      var spent = g.acc;
      g.acc = 0;
      g.tickFn(spent);
    }
  }

  // 只要还有一个门想要帧，循环就得继续转。反过来说，每个子系统都必须在自己
  // 闲下来的时候把目标帧率报成 0 —— 这是整个循环唯一的停机依据。
  function anyGateWants() {
    for (var i = 0; i < gates.length; i += 1) {
      if (gates[i].fpsFn() > 0) return true;
    }
    return false;
  }

  function frame() {
    rafId = 0;

    // dt：lerp 要按真实帧间隔归一化，否则 30fps 的机器滚动会慢一半。
    // 标签页切回来时 dt 可能是几千毫秒，截断掉，免得一帧就冲过整段歌词。
    var t = now();
    lastDt = lastFrameAt ? clamp(t - lastFrameAt, 1, 200) : 16.7;
    lastFrameAt = t;

    runGates(lastDt);
    sampleFrameRate();
    if (!hidden && (playing || energy > 0.005 || isPageOpen() || anyGateWants())) schedule();
  }

  // 歌词更新的目标帧率。好机器上 60 等于不节流（rAF 本来就被显示器限着），
  // 只有降级档和前后台状态才真的往下压。
  function lyricsTargetFps() {
    if (hidden) return 0;
    if (!playing) return isPageOpen() ? 24 : 12;
    if (reduced) return 15;
    return tier === 0 ? 24 : tier === 1 ? 40 : 60;
  }

  function tickLyrics(dtMs) {
    lastDt = dtMs;
    var pos = seeking ? basePos : currentPos();
    if (!doc) { if (!seeking) paintProgress(pos); return; }
    var i = resolveIndex(doc, pos);
    var changed = i !== activeIdx;
    // 一次跨掉 tune.snapSpan 行以上说明是拖进度条 / 切歌，逐帧追只会糊成一片，
    // 直接落位。activeIdx > -2 是为了跳过「歌词刚加载」那一帧的伪跳变。
    var snap = changed && activeIdx > -2 && Math.abs(i - activeIdx) >= tune.snapSpan;
    activeIdx = i;
    update(i, pos, snap, changed);
    // 漂移/环转是持续的低频运动，跟着歌词帧门走：降级时歌词掉到 24fps，
    // 背景也一起掉，不会出现"歌词停了但场景还在慢慢转"的割裂感。
    for (var k = 0; k < views.length; k += 1) writeTilt(views[k], dtMs);
    if (!seeking) paintProgress(pos);
  }

  function energyTargetFps() {
    if (hidden) return 0;
    if (!playing) return 12;
    return lowfx || reduced ? 10 : 20;
  }

  function tickEnergy(dtMs) {
    pushEnergy(playing && !reduced ? sampleEnergy() : 0, dtMs);
    paintEnergy();
    stepBeat(dtMs);
  }

  var spectrum = null;
  function sampleEnergy() {
    if (!spectrum || !spectrum.length) return 0;
    var sum = 0;
    for (var i = 0; i < spectrum.length; i += 1) sum += spectrum[i] || 0;
    return sum / spectrum.length;
  }

  function schedule() {
    if (rafId || hidden) return;
    // 循环每停一次再起来，中间空掉的那段时间不能算进 dt
    lastFrameAt = 0;
    rafId = requestAnimationFrame(frame);
  }

  // 标签页不可见时 rAF 会被浏览器停掉，但循环里那些 setTimeout/计时不会。
  // 索性整个熄掉：切走的这段时间一行 DOM 都不写，回来再补一次基准。
  var hidden = false;
  function setHidden(v) {
    if (hidden === v) return;
    hidden = v;
    if (!v) { lastFrameAt = 0; fps.since = 0; schedule(); }
    else if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // 窄屏（≤1240px）舞台是右侧抽屉，关着的时候画布只是被 transform 移出
  // 屏幕——布局尺寸原样保留，GL 不被告知就会持续往不可见画面上烧 GPU。
  var narrow = false;
  function isStageVisible() {
    if (hidden) return false;
    if (!narrow) return true;
    return document.body.classList.contains('stage-open');
  }

  // 帧率只在「连续播放」时才有意义：暂停后 rAF 会停，稀疏的几帧不能拿来算。
  // 另外起步 1.2s 天然抖（首帧渲染 + WS 建连），量它只会把好机器判成弱机。
  function sampleFrameRate() {
    if (fps.done || !playing) return;
    var t = now();
    if (!fps.since || t - fps.last > 250) {
      fps.since = t; fps.frames = 0; fps.last = t;
      return;
    }
    fps.last = t;
    var span = t - fps.since;
    if (span < 1200) { fps.frames = 0; return; }
    fps.frames += 1;
    if (span < 3200) return;
    var f = (fps.frames * 1000) / (span - 1200);
    fps.done = true;
    // 低于 40fps 才认为这台机器扛不住大面积模糊；阈值定太低会让好机器也降级。
    if (f < 40) setLowFx(true);
    document.dispatchEvent(new CustomEvent('stage:fps', { detail: { fps: f, lowfx: lowfx } }));
  }

  function setLowFx(on) {
    if (lowfx === on) return;
    lowfx = on;
    document.body.classList.toggle('stage-lowfx', on);
    // 降级会连带改掉歌词的节流档，立刻补一次，别等到下一个帧门周期
    views.forEach(function (v) { if (v && v.dim) v.dim(activeIdx); });
    schedule();
  }

  var lastSec = -1;
  function paintProgress(pos) {
    var d = durMs || 0;
    // 时间文本只精确到秒，没必要每帧改 DOM
    var sec = Math.floor(pos / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      var text = fmt(pos) + ' / ' + fmt(d);
      if (el.stageTime) el.stageTime.textContent = text;
      if (el.lpTime) el.lpTime.textContent = text;
    }
    if (el.stageRange && !seeking) {
      el.stageRange.max = String(d || 1000);
      el.stageRange.value = String(Math.min(pos, d || pos));
    }
    if (el.lpRange && !seeking) {
      el.lpRange.max = String(d || 1000);
      el.lpRange.value = String(Math.min(pos, d || pos));
    }
  }

  function fmt(ms) {
    if (!ms || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s -= m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // -------------------------------------------------------------------------
  // 对外事件
  // -------------------------------------------------------------------------

  function emit(action, value) {
    document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: action, value: value } }));
  }

  // -------------------------------------------------------------------------
  // 模式
  // -------------------------------------------------------------------------

  function setMode(next, opts) {
    if (next === 'page') { setPage(true); return; }
    // 星河 = 打开全屏页并切到星河背景场景，与歌词展示模式无关
    if (next === 'starriver') {
      setScene('starriver', { force: true });
      setPage(true);
      return;
    }
    if (BASE_MODES.indexOf(next) < 0) next = 'karaoke';
    mode = next;
    if (el.stage) el.stage.setAttribute('data-mode', mode);
    // 全屏页用独立的属性承载模式：它的排版差异比侧栏大（居中、散开、发光），
    // 选择器挂在 .lyric-page 上比复用 data-mode 更清楚，也不会互相牵连。
    if (el.page) el.page.setAttribute('data-lp-mode', mode === 'cover' ? 'karaoke' : mode);
    syncLpModes();
    if (el.modes) {
      Array.prototype.forEach.call(el.modes.children, function (b) {
        var m = b.getAttribute('data-mode');
        b.classList.toggle('active', m === mode || (m === 'page' && isPageOpen()));
        b.setAttribute('aria-pressed', String(b.classList.contains('active')));
      });
    }
    if (!(opts && opts.silent)) {
      try { localStorage.setItem(STORE_KEY, mode); } catch (e) { /* 隐私模式 */ }
    }
    // cover 模式会把 .stage-lyrics 整个 display:none，切回来时量出来的高度
    // 全是旧的，必须重算并直接落位。
    refresh(true);
    schedule();
  }

  function syncLpModes() {
    if (!el.lpModes) return;
    Array.prototype.forEach.call(el.lpModes.children, function (b) {
      var on = b.getAttribute('data-lp-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function isPageOpen() {
    return !!(el.page && el.page.classList.contains('open'));
  }

  function setPage(open) {
    if (!el.page) return;
    var want = open === undefined ? !isPageOpen() : !!open;
    el.page.classList.toggle('open', want);
    el.page.setAttribute('aria-hidden', String(!want));
    document.body.classList.toggle('lp-open', want);
    if (el.modes) {
      Array.prototype.forEach.call(el.modes.children, function (b) {
        var m = b.getAttribute('data-mode');
        b.classList.toggle('active', m === 'page' ? want : (!want && m === mode));
      });
    }
    // 打开时直接落位，避免动画过程中从列表顶端一路追下来
    refresh(true);
    schedule();
    // GL 层按帧门节流：暂停空闲时它的目标帧率是 0，上面 schedule 的这一帧
    // 不会带它跑。让创意舞台为这次视图切换补一帧，全屏页/舞台才不会空白或
    // 停留在上一句歌词。
    if (window.CreativeStage && CreativeStage.kick) CreativeStage.kick();
  }

  // -------------------------------------------------------------------------
  // 舞台氛围层
  // -------------------------------------------------------------------------

  // 两个纯装饰的空 div，视觉完全由 stage-control.js 写进来的 --fx-* 变量驱动。
  // 放在 JS 里注入而不是写死进 HTML：没加载 stage-control.js 时页面不会凭空
  // 多出两个永远透明的元素；注入顺序放在歌词容器之前，避免抢 z-index。
  function mountFxLayers() {
    ['stage-fx', 'stage-dots'].forEach(function (cls) {
      if (el.stage.querySelector('.' + cls)) return;
      var node = document.createElement('div');
      node.className = cls;
      node.setAttribute('aria-hidden', 'true');
      var lyrics = el.stage.querySelector('.stage-lyrics');
      if (lyrics) el.stage.insertBefore(node, lyrics);
      else el.stage.appendChild(node);
    });
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  // 全屏页头部的背景场景切换组：封面 / 星河
  function buildSceneButtons() {
    var head = document.querySelector('.lp-head');
    if (!head || head.querySelector('.lp-scenes')) return null;
    var group = document.createElement('div');
    group.className = 'lp-scenes';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '舞台背景');
    [['cover', '封面'], ['starriver', '星河']].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lp-scene-btn';
      b.setAttribute('data-scene', pair[0]);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = pair[1];
      b.addEventListener('click', function () { setScene(pair[0]); });
      group.appendChild(b);
    });
    // 插在歌词模式组之前：先选背景、再选歌词排版
    var modes = $('lp-modes');
    if (modes && modes.parentNode === head) head.insertBefore(group, modes);
    else head.insertBefore(group, head.children[1]);
    return group;
  }

  // 自动 360° 环转按钮：放在圆形封面按钮之前
  function buildAutoSpinButton() {
    var head = document.querySelector('.lp-head');
    if (!head || $('lp-autospin')) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lp-btn';
    btn.id = 'lp-autospin';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('title', '自动 360° 旋转');
    btn.setAttribute('aria-label', '自动 360° 旋转');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-reset"/></svg>';
    var coverBtn = $('lp-cover');
    if (coverBtn && coverBtn.parentNode === head) head.insertBefore(btn, coverBtn);
    else head.appendChild(btn);
    return btn;
  }

  function init() {
    el.stage = $('stage');
    el.disc = $('cover');
    el.ring = $('disc-ring');
    el.modes = $('stage-modes');
    el.stageRange = $('stage-progress');
    el.stageTime = $('stage-time');
    el.page = $('lyric-page');
    el.pageLines = $('lp-lines');
    el.lpTitle = $('lp-title');
    el.lpSub = $('lp-sub');
    el.lpTime = $('lp-time');
    el.lpRange = $('lp-progress');
    el.lpModes = $('lp-modes');

    if (!el.stage) return;

    readTune();
    mountFxLayers();

    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 窄屏断点跟 CSS 的抽屉规则共用同一个数（style.css：max-width:1240）。
    var narrowMql = window.matchMedia('(max-width: 1240px)');
    narrow = narrowMql.matches;
    var onNarrowChange = function (e) { narrow = e.matches; };
    if (narrowMql.addEventListener) narrowMql.addEventListener('change', onNarrowChange);
    else if (narrowMql.addListener) narrowMql.addListener(onNarrowChange);
    tier = detectTier();
    // 弱机先按降级启动。帧率探针后面测出来够用也不会自动升回来——升档会让
    // 画面突然多出一层效果，比一直朴素着更让人不适。
    if (tier === 0) setLowFx(true);

    buildRing(tier === 0 ? 0 : 36);

    if (el.stageRange) {
      el.stageRange.addEventListener('pointerdown', function () { seeking = true; });
      el.stageRange.addEventListener('input', function () {
        basePos = Number(el.stageRange.value) || 0;
        clockAt = now();
        paintProgress(basePos);
      });
      el.stageRange.addEventListener('change', function () {
        seeking = false;
        emit('seek', Number(el.stageRange.value) || 0);
      });
    }

    if (el.lpRange) {
      el.lpRange.addEventListener('pointerdown', function () { seeking = true; });
      el.lpRange.addEventListener('input', function () {
        basePos = Number(el.lpRange.value) || 0;
        clockAt = now();
        paintProgress(basePos);
      });
      el.lpRange.addEventListener('change', function () {
        seeking = false;
        emit('seek', Number(el.lpRange.value) || 0);
      });
    }

    if (el.modes) {
      el.modes.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.stage-mode') : null;
        if (!b) return;
        var m = b.getAttribute('data-mode');
        if (m === 'page') setPage(!isPageOpen());
        else setMode(m);
      });
    }

    var q = $('stage-queue');
    if (q) q.addEventListener('click', function () { emit('view', 'queue'); });

    var close = $('lp-close');
    if (close) close.addEventListener('click', function () { setPage(false); });

    var lpPlay = $('lp-play');
    if (lpPlay) lpPlay.addEventListener('click', function () { emit('toggle'); });
    var lpPrev = $('lp-prev');
    if (lpPrev) lpPrev.addEventListener('click', function () { emit('prev'); });
    var lpNext = $('lp-next');
    if (lpNext) lpNext.addEventListener('click', function () { emit('next'); });

    if (el.lpModes) {
      el.lpModes.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.lp-mode') : null;
        if (b) setMode(b.getAttribute('data-lp-mode'));
      });
    }
    var lpReset = $('lp-view-reset');
    if (lpReset) lpReset.addEventListener('click', function () { views.forEach(resetTilt); });
    var lpCover = $('lp-cover');
    if (lpCover) lpCover.addEventListener('click', function () { setCover(!cover.on); });
    var lpCockpit = $('lp-cockpit');
    if (lpCockpit) lpCockpit.addEventListener('click', function () {
      // 驾驶舱本身（stage-control.js）挂在 body 上、z-index 高于本页，
      // 所以在这里直接开它就行，不需要把面板搬进全屏页里再维护两份。
      if (window.StageControl) StageControl.toggle();
    });

    // 背景场景切换组（封面 / 星河）：动态注入到全屏页头部、歌词模式组之前
    el.sceneBtns = buildSceneButtons();
    // 自动 360° 环转按钮
    var lpAutoSpin = buildAutoSpinButton();
    if (lpAutoSpin) lpAutoSpin.addEventListener('click', function () { setAutoSpin(); });

    // 侧栏星河按钮（#mode-starriver）的点击已由 el.modes 的统一处理覆盖，
    // 这里不重复绑定；其高亮状态由 syncSceneBtns 同步。

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isPageOpen()) { e.stopPropagation(); setPage(false); }
    }, true);

    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式 */ }
    // 迁移：已合并的 'line' → 'karaoke'
    if (saved === 'line') {
      saved = 'karaoke';
      try { localStorage.setItem(STORE_KEY, saved); } catch (e) { /* ignore */ }
    }
    setMode(saved || 'karaoke', { silent: true });

    // 背景场景与自动环转：持久化在各自的 localStorage 键里
    try {
      var sv = localStorage.getItem(SCENE_KEY);
      if (SCENES.indexOf(sv) >= 0) scene = sv;
      autoSpin = localStorage.getItem(SPIN_KEY) === '1';
    } catch (e) { /* 隐私模式 */ }

    readTilt();
    views = [
      createView($('lyrics'), false),
      createView(el.pageLines, true)
    ];
    views.forEach(bindTiltDrag);
    // 封面可能在 init 之前就通过 setTrack 进来了（那时 .lp-cover 还不存在）。
    paintCover();

    // 节拍检测器（起音 → --beat 包络）。必须在闸门启动前建好。
    beatDet = window.Onset ? Onset.create() : null;

    // 两个常驻子系统先登记，后面舞台粒子（stage-particles.js）也走同一个门。
    defineGate('lyrics', lyricsTargetFps, tickLyrics);
    defineGate('energy', energyTargetFps, tickEnergy);

    // 视口变了，缓存的行几何全部作废——尤其是窄屏下舞台变成抽屉、
    // 全屏页从 visibility:hidden 出来的那一刻，clientHeight 从 0 变成真值。
    var relayout = debounce(function () { refresh(true); schedule(); }, 90);
    window.addEventListener('resize', relayout);
    if (window.ResizeObserver) {
      views.forEach(function (v) {
        if (v.container) new ResizeObserver(relayout).observe(v.container);
      });
    }

    document.addEventListener('visibilitychange', function () {
      setHidden(document.hidden);
    });

    // 驾驶舱改了倾角上限 / 漂移 / 透视之后要重读一遍。CSS 变量本身会即时生效
    // 在 --lp-persp 这类纯视觉量上，但 tilt.max 和 tilt.drift 是 JS 读进变量的
    // 数值——不重读的话那两颗旋钮拖了没有任何反应，而且不报错。
    document.addEventListener('stagecontrol:change', function (e) {
      readTilt();
      views.forEach(writeTilt);
      // 律动幅度：驾驶舱的初始 emit 在本监听器注册之前，下面另做一次冷读。
      if (e.detail && e.detail.beatAmp !== undefined) {
        beatAmp = clamp((Number(e.detail.beatAmp) || 0) / 100, 0, 2);
      }
    });
    // 冷读驾驶舱当前值（它的 init 排在 Stage.init 之前，初始广播已错过）
    if (window.StageControl) {
      var cv = StageControl.values();
      if (cv.beatAmp !== undefined) {
        beatAmp = clamp((Number(cv.beatAmp) || 0) / 100, 0, 2);
      }
    }

    schedule();
  }

  function debounce(fn, ms) {
    var timer = 0;
    return function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------

  window.Stage = {
    init: init,
    destroy: destroy,
    removeGate: removeGate,
    // 子系统自己的目标帧率从 0 变正（如背景从主题切到弧形墙且正暂停）时，
    // 靠它冷启动循环；循环已在转时是空操作，没人想要帧时帧循环会自行停下。
    kick: function () { schedule(); },
    // 背景子模块异步就绪/重试成功后，重算 has-cover/gl-active 等类
    repaint: function () { paintCover(); schedule(); },
    setMode: setMode,
    togglePage: function () { setPage(); },
    setPage: setPage,
    isPageOpen: isPageOpen,
    setReducedMotion: function (v) { reduced = !!v; },
    setLowFx: setLowFx,
    // 舞台封面盘开关。随时可切：显示与否只是一个 class，旋转是 CSS 动画，
    // 既不用重载也不用重建 DOM。emit 出去的 'cover' 由 app.js 落到设置里。
    setCoverMode: setCover,
    isCoverMode: function () { return cover.on; },
    // 舞台视角：驾驶舱从这里读写，复位也留一个口子
    resetView: function () { views.forEach(resetTilt); },
    tiltState: function () {
      var v = views[1];
      return v ? { x: v.tiltX, y: v.tiltY, max: tilt.max, drift: tilt.drift } : null;
    },
    setTiltDrift: function (v) { tilt.drift = v; },

    // 当前曲目封面 URL（可能是同源 /v1/tracks/.. 封面，也可能是在线音源远程图）。
    // 粒子封面据此加载纹理，不在这里拿的话只能去 img.src 反解。
    coverUrl: function () { return lastCover; },

    // 当前背景场景（'cover' / 'starriver'）与自动环转状态，
    // 背景子模块据此决定自己该不该画
    scene: function () { return scene; },
    setScene: setScene,
    isAutoSpin: function () { return autoSpin; },
    setAutoSpin: setAutoSpin,

    setTrack: function (t, coverUrl) {
      track = t || null;
      lastCover = coverUrl || null;
      if (el.lpTitle) el.lpTitle.textContent = (t && t.title) || '未在播放';
      var lpArtist = $('lp-artist');
      if (lpArtist) lpArtist.textContent = (t && t.artist) || '';
      if (el.disc) {
        el.disc.style.backgroundImage = coverUrl ? 'url("' + coverUrl + '")' : 'none';
        el.disc.classList.toggle('is-empty', !coverUrl);
      }
      extractPalette(coverUrl);
      paintCover();
      schedule();
    },

    setSnapshot: function (snap) {
      if (!snap) return;
      durMs = snap.duration_ms || 0;
      var nextPlaying = !!snap.playing;
      // 服务端位置只在「明显不一致」时才覆盖本地时钟，避免每次推送都跳一下
      var srv = snap.position_ms || 0;
      if (!playing || Math.abs(srv - currentPos()) > 700 ||
        (snap.track_id && (!track || track.id !== snap.track_id))) {
        basePos = srv;
        clockAt = now();
        // 这是一次真跳变（换曲 / seek 生效），抗回退的基准要让出去
        guardPos = -1;
      }
      playing = nextPlaying;
      document.body.classList.toggle('is-playing', playing);
      var lpPlay = $('lp-play');
      if (lpPlay) lpPlay.classList.toggle('is-playing', playing);
      paintProgress(currentPos());
      schedule();
    },

    // 频谱只存下来，不在这里写任何样式。服务端按 33ms 一帧推 64 段，
    // 直接在回调里刷 CSS 等于绕过帧门——写 CSS 的活儿全部交给 energy 门。
    setSpectrum: function (bands) {
      spectrum = bands && bands.length ? bands : null;
    },

    setLyrics: function (d) {
      doc = (d && d.lines && d.lines.length) ? d : null;
      activeIdx = -2;
      guardPos = -1;
      views.forEach(function (v) { v.build(doc); });
      if (!doc) { views.forEach(function (v) { v.dim(-1); }); schedule(); return; }
      var pos = currentPos();
      var i = resolveIndex(doc, pos);
      update(i, pos, true, true);
      activeIdx = i;
      schedule();
    },

    // -------------------------------------------------------------------------
    // 给其它表现层模块（舞台粒子、歌单架）用的三个口子。
    // 主循环的 rAF 只有一个，谁要按帧驱动就 register 一个门，不要再各起一个
    // requestAnimationFrame —— 多个循环会让同一帧里发生两次布局/样式计算。
    // -------------------------------------------------------------------------

    // Stage.gate('particles', function(){ return 30; }, function(dt){ ... })
    gate: defineGate,
    // 当前设备档位（0 eco / 1 balanced / 2 high）与降级态。帧率探针只会把它
    // 往下调，所以启动后任何时刻读到的都是「这台机器目前确定扛得住的上限」。
    tier: function () { return lowfx ? 0 : tier; },
    isLowFx: function () { return lowfx; },
    isHidden: function () { return hidden; },
    // GL 层据此判断活动画布当前是否真的可见（窄屏抽屉关着 = 不可见）。
    isStageVisible: isStageVisible,
    // 已经平滑过的能量，0–1。粒子层直接吃这个值比自己重算 FFT 均值便宜，
    // 而且和光晕保持同一套响应速度，不会出现两层节奏不一致。
    energy: function () { return energy; },
    spectrum: function () { return spectrum; },
    // 播放位置（毫秒），已经做过本地插值。表现层要跟着音乐走就用它，
    // 不要去读快照的原始 position_ms——那个只有推送到的瞬间才是准的。
    position: currentPos,

    // 三维歌词场景的只读快照：行数组（{start_ms,text}）+ 当前行号。
    // 行号在歌词未定位时给 0，由消费方自行处理无歌词占位。
    lyrics: function () {
      return doc ? { lines: doc.lines, index: activeIdx < 0 ? 0 : activeIdx } : null;
    },

    // 运行时改旋钮：Stage.tune({ 'dim-step': 0.35, 'lerp': 0.2 })
    // 键名就是 stage.css 里去掉 --lyric- 前缀的那一段。不传参返回当前值。
    tune: function (patch) {
      if (!patch) return JSON.parse(JSON.stringify(tune));
      Object.keys(patch).forEach(function (k) {
        document.documentElement.style.setProperty('--lyric-' + k, String(patch[k]));
      });
      readTune();
      readTilt();
      refresh(true);
      schedule();
      return JSON.parse(JSON.stringify(tune));
    },

    // 换主题后调用：主题改的是 --accent / --text 这一层，而歌词的距离衰减、
    // 取色背景都是从 CSS 变量里读的，需要重新采一遍，否则新主题下会残留旧色。
    retint: function () {
      readTune();
      if (lastCover) extractPalette(lastCover);
      else resetPalette();
      refresh(true);
      schedule();
    }
  };
})();
