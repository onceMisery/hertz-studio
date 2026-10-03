// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// 商籁 sonnet：全屏 Pixi 电影镜头歌词。独立于 classic/cadenza 的第三个 stanza 渲染器，
// 对外 API 与其余渲染器一致（frame/update/setTheme/.../destroy）。
// 数据只认 Stage 门面（时间/歌词/频谱/演示态），不自建时钟、不自行解析歌词文档。
// PixiJS 惰性加载：首次切到商籁才注入 vendor/pixi.min.js，其余布局零开销。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;
  var FX = global.StanzaSonnetFx;
  var PIXI_URL = '/vendor/pixi.min.js';

  // 插件形态的 srcdoc base 落在 …/stage-themes/ 下，裸相对路径会解析到那里而 404，
  // Pixi 永远加载不起来、商籁与凝彩都初始化不了。与 stage3d.js 壁纸同一类问题：
  // 声明保持根相对，真正赋给 DOM 时过宿主的 assetUrl 补全到 ui 根。
  function assetUrl(url) {
    return global.hertzHost && global.hertzHost.assetUrl ? global.hertzHost.assetUrl(url) : url;
  }

  function colorNumber(value, fallback) {
    var rgb = U.hexToRgb(value);
    return rgb ? (rgb.r << 16) | (rgb.g << 8) | rgb.b : fallback;
  }

  // ------------------------------------------------------------------
  // Stage → 帧适配：把毫秒制歌词文档整形成引擎的秒制帧对象。
  // 归一化结果按行数组身份缓存（Stage.lyrics() 稳定返回 doc.lines）。
  // ------------------------------------------------------------------

  var lineCache = new WeakMap();

  function hintsFor(line) {
    var h = U.renderHints(line);
    return {
      // renderHints 分级 → 引擎转场名（与 classic 的映射一致）
      lineTransitionMode: h.timingClass === 'micro' ? 'none' : h.timingClass === 'short' ? 'fast' : 'normal',
      renderEndTime: h.renderEndMs / 1000,
      glyphStyle: 'rise'
    };
  }

  function normalizeLines(rawLines) {
    var cached = lineCache.get(rawLines);
    if (cached) return cached;
    var out = rawLines.map(function (raw, i) {
      var next = rawLines[i + 1];
      var startTime = U.num(raw.start_ms, 0) / 1000;
      var declaredEnd = U.num(raw.end_ms, 0) / 1000;
      var nextStart = next ? U.num(next.start_ms, NaN) / 1000 : NaN;
      // 行尾兜底： declared end → 下一行起点 → +5s；至少 80ms 防零长。
      var endTime = Math.max(startTime + 0.08,
        declaredEnd > startTime ? declaredEnd : (isFinite(nextStart) && nextStart > startTime ? nextStart : startTime + 5));
      var tokens = (global.Stage && Stage.lyricTokens) ? Stage.lyricTokens(raw) : [];
      var words = tokens.map(function (w, wi) {
        var ws = U.num(w.start_ms, raw.start_ms) / 1000;
        var we = Math.max(ws, U.num(w.end_ms, raw.end_ms != null ? raw.end_ms : raw.start_ms) / 1000);
        return { text: String(w.text == null ? '' : w.text), startTime: ws, endTime: we, index: wi };
      });
      var fullText = String(raw.text == null ? '' : raw.text);
      var line = {
        index: i,
        startTime: startTime,
        endTime: endTime,
        fullText: fullText,
        words: words,
        isChorus: false,
        renderHints: hintsFor(raw)
      };
      line.vocalEndTime = words.reduce(function (m, w) { return Math.max(m, w.endTime); }, startTime);
      return line;
    });
    lineCache.set(rawLines, out);
    return out;
  }

  function activeIndexOf(lines, t) {
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].startTime <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function buildFrame(host) {
    var pres = (global.Stage && Stage.presentation) ? Stage.presentation() : null;
    var positionS = (global.Stage && Stage.position ? Stage.position() : 0) / 1000;
    var doc = (global.Stage && Stage.lyrics) ? Stage.lyrics() : null;
    var rawLines = doc && doc.lines ? doc.lines : null;
    var lines = rawLines ? normalizeLines(rawLines) : [];
    var idx = activeIndexOf(lines, positionS);
    var activeLine = idx >= 0 ? lines[idx] : null;
    var dur = activeLine ? Math.max(0.001, activeLine.endTime - activeLine.startTime) : 1;
    var spectrum = (global.Stage && Stage.spectrum && Stage.spectrum()) || [];
    return {
      playbackTime: positionS,
      isPlaying: !!(pres && pres.playing),
      currentLineIndex: idx,
      activeLine: activeLine,
      nextLines: idx >= 0 ? lines.slice(idx + 1, idx + 4) : lines.slice(0, 3),
      lineProgress: activeLine ? U.clamp((positionS - activeLine.startTime) / dur, 0, 1) : 0,
      lines: lines,
      audio: FX.resolveAudioBands(spectrum),
      viewport: {
        width: Math.max(1, host.clientWidth || global.innerWidth || 1),
        height: Math.max(1, host.clientHeight || global.innerHeight || 1)
      },
      track: pres ? pres.track : null,
      reduced: !!(pres && pres.reduced)
    };
  }

  // ------------------------------------------------------------------
  // Pixi 惰性加载（全页只注入一次；失败回调一次，供降级提示）
  // ------------------------------------------------------------------

  var pixiLoading = null;
  function loadPixi() {
    if (global.PIXI) return Promise.resolve(global.PIXI);
    if (pixiLoading) return pixiLoading;
    pixiLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = assetUrl(PIXI_URL);
      s.onload = function () { global.PIXI ? resolve(global.PIXI) : reject(new Error('PIXI missing after load')); };
      s.onerror = function () { pixiLoading = null; reject(new Error('pixi.min.js load failed')); };
      document.head.appendChild(s);
    });
    return pixiLoading;
  }

  // ------------------------------------------------------------------
  // 编排导演：一句一「镜头」。背景构图六选一、镜头调度七选一，全部由
  // seed（曲目+行起点）确定性抽取 —— seek 回来画面不换样。
  // ------------------------------------------------------------------

  function SonnetDirector(root, onSeek) {
    this.root = root;
    this.onSeek = onSeek;
    this.app = null;
    this.initialized = false;
    this.destroyed = false;
    this.pendingShot = null;
    this.width = 1;
    this.height = 1;
    this.accent = { r: 244, g: 244, b: 245 };
    this.numPrimary = 0xf4f4f5;
    this.fontStack = '"Inter","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
    this.backgroundKind = 'orbital';
    this.activeKind = 'quiet-tableau';
    this.words = [];
    this.phrases = [];
    this.orbits = [];
    this.accents = null;
    this.editorialTrack = null;
    this.giantText = null;
    this.motif = null;
    this.scan = null;
    this.performance = FX.createPerformance();
    this.postProcess = null;
    this.optical = null;
    this.atmosphere = null;
    this.retirement = null;
  }

  SonnetDirector.prototype.init = function () {
    var self = this;
    return loadPixi().then(function (PIXI) {
      if (self.destroyed) return;
      var application = new PIXI.Application();
      self.app = application;
      return application.init({
        backgroundAlpha: 0,
        preference: 'webgl',
        autoStart: false,
        antialias: true,
        resolution: Math.min(2, global.devicePixelRatio || 1),
        autoDensity: true
      }).then(function () {
        // await 期间可能已被 destroy：只回收自己刚建的应用，不碰已被接管的状态。
        if (self.destroyed || self.app !== application) {
          application.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
          if (self.app === application) self.app = null;
          return;
        }
        application.stop();
        self.root.appendChild(application.canvas);
        application.canvas.className = 'fl-sonnet-canvas';
        self.sceneContainer = new PIXI.Container();
        self.geoContainer = new PIXI.Container();
        self.hudContainer = new PIXI.Container();
        self.frameDecorContainer = new PIXI.Container();
        self.markLayer = new PIXI.Container();
        self.atmosphereLayer = new PIXI.Container();
        self.textContainer = new PIXI.Container();
        self.trackContainer = new PIXI.Container();
        // 添加顺序保持 geo → hud 不变：契约脚本 check-sonnet-palette 按
        // stage.children[0].children[0..1] 定位巨型布景与 HUD，改顺序会直接失败。
        // 真正的层序交给 zIndex 决定（见下），两者解耦。
        self.sceneContainer.addChild(self.geoContainer, self.hudContainer,
          self.frameDecorContainer, self.markLayer, self.atmosphereLayer,
          self.textContainer, self.trackContainer);
        // 渲染顺序：氛围光在最底（只给明暗过渡，不能糊掉线稿）→ 巨型布景 → HUD →
        // 框线 → 角标（取景器语义，歌词从框里穿过）→ 正文。
        self.sceneContainer.sortableChildren = true;
        self.atmosphereLayer.zIndex = -10;
        self.geoContainer.zIndex = 0;
        self.hudContainer.zIndex = 10;
        self.frameDecorContainer.zIndex = 20;
        self.markLayer.zIndex = 30;
        self.textContainer.zIndex = 40;
        self.trackContainer.zIndex = 40;
        application.stage.addChild(self.sceneContainer);
        self.editorialTrack = createEditorialTrack(PIXI, self.trackContainer, self.fontStack);
        self.optical = FX.createOpticalChain(PIXI, application.stage);
        self.postProcess = self.optical.print;
        self.retirement = FX.createRetirement(PIXI, application.stage);
        self.initialized = true;
        self.resize();
        if (self.pendingShot) self.buildShot.apply(self, self.pendingShot);
      });
    });
  };

  SonnetDirector.prototype.resize = function () {
    if (!this.initialized || !this.app) return;
    var width = Math.max(1, this.root.clientWidth);
    var height = Math.max(1, this.root.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.app.renderer.resize(width, height);
    if (this.pendingShot) this.buildShot.apply(this, this.pendingShot);
  };

  SonnetDirector.prototype.buildShot = function (line, seed, accentColor, tuning) {
    this.pendingShot = [line, seed, accentColor, tuning];
    if (!this.initialized || this.destroyed) return;
    var PIXI = global.PIXI;
    this.activeKind = FX.shotKind(seed, tuning);
    this.accent = accentColor || { r: 244, g: 244, b: 245 };
    this.numPrimary = (this.accent.r << 16) | (this.accent.g << 8) | this.accent.b;
    var numPrimary = this.numPrimary;
    var palette = tuning.palette || {};
    var numSecondary = colorNumber(palette.secondary, numPrimary);
    var numTertiary = colorNumber(palette.tertiary, numPrimary);
    var rand = FX.seededRandom('sonnet:' + seed);
    var width = this.width, height = this.height;
    var cx = width * 0.5, cy = height * 0.5;
    var radius = Math.min(width, height) * 0.38;

    this.retirement.capture([this.geoContainer, this.hudContainer], this.sceneContainer, line, this.words);
    this.backgroundKind = FX.sceneKind(seed);

    // 1. 外框线系统：四角括标 + 上下标尺刻度（画面常驻的「取景器」）。
    this.frameDecorContainer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    var frame = new PIXI.Graphics();
    var padX = width * 0.08, padY = height * 0.12;
    var fw = width - padX * 2, fh = height - padY * 2;
    var corner = 24;
    frame.moveTo(padX, padY + corner).lineTo(padX, padY).lineTo(padX + corner, padY);
    frame.moveTo(padX + fw - corner, padY).lineTo(padX + fw, padY).lineTo(padX + fw, padY + corner);
    frame.moveTo(padX, padY + fh - corner).lineTo(padX, padY + fh).lineTo(padX + corner, padY + fh);
    frame.moveTo(padX + fw - corner, padY + fh).lineTo(padX + fw, padY + fh).lineTo(padX + fw, padY + fh - corner);
    frame.stroke({ color: numSecondary, width: 2, alpha: 0.65 });
    for (var x = padX + 40; x < padX + fw - 40; x += 30) {
      var long = x % 90 === 0 ? 10 : 5;
      frame.moveTo(x, padY).lineTo(x, padY + long);
      frame.moveTo(x, padY + fh).lineTo(x, padY + fh - long);
    }
    frame.stroke({ color: numPrimary, width: 1, alpha: 0.35 });
    this.frameDecorContainer.addChild(frame);

    // 1b. 虚线标尺：设计意图是「镂空巨字 + 刻度边框 + 虚线标尺」三件套。
    // 刻度边框只有实线短线，缺少那层"印刷套准线"的断续节奏，所以在这里补一段
    // 独立的虚线标尺。刻意与 frame 分成两个 Graphics：虚线要独立的 alpha/线宽，
    // 混进同一个 stroke() 会被后一次 stroke 覆盖。
    // 同样挂在 frameDecorContainer（不随 sceneContainer 的相机变换），
    // 因此只需在 build 时画一次，update 时零重绘。
    var ruler = new PIXI.Graphics();
    // 上下各一条横向虚线：段长 14px、间隙 9px。用 moveTo/lineTo 逐段画而不是
    // setLineDash —— 后者在不同 Pixi 版本上对 Graphics 的支持并不一致。
    var dashOn = 14, dashOff = 9, seg = dashOn + dashOff;
    for (var rx = padX + 20; rx < padX + fw - 20; rx += seg) {
      var run = Math.min(dashOn, padX + fw - 20 - rx);
      if (run <= 0) break;
      // 上轨留出角标缺口，四角附近不画，免得与 corner 括标叠在一起显脏。
      if (rx > padX + corner + 8 && rx + run < padX + fw - corner - 8) {
        ruler.moveTo(rx, padY + 16).lineTo(rx + run, padY + 16);
        ruler.moveTo(rx, padY + fh - 16).lineTo(rx + run, padY + fh - 16);
      }
    }
    ruler.stroke({ color: numSecondary, width: 1, alpha: 0.4 });
    // 左右各一条纵向虚线，段长刻意与横向错开（11/13），避免四角形成对称的十字。
    for (var ry = padY + 20; ry < padY + fh - 20; ry += 24) {
      var vrun = Math.min(11, padY + fh - 20 - ry);
      if (vrun <= 0) break;
      if (ry > padY + corner + 8 && ry + vrun < padY + fh - corner - 8) {
        ruler.moveTo(padX + 16, ry).lineTo(padX + 16, ry + vrun);
        ruler.moveTo(padX + fw - 16, ry).lineTo(padX + fw - 16, ry + vrun);
      }
    }
    ruler.stroke({ color: numPrimary, width: 1, alpha: 0.28 });
    this.frameDecorContainer.addChild(ruler);

    // 1c. 氛围光层：两团缓慢漂移的柔光 + 上下渐隐压边。
    // 挂在 atmosphereLayer 而不是 geoContainer —— 巨型布景在「图片背景」模式下要整层
    // 隐藏（契约 check-sonnet-palette 断言 children[0].visible === false），柔光不能跟着一起
    // 消失，否则换图片背景时画面会从「有空气」突变为「纯贴图」。
    // 固定画幅、不随相机移动：它是「 venue 的灯」而不是「画面里的东西」。
    if (this.atmosphere) this.atmosphere.destroy();
    this.atmosphereLayer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    this.atmosphere = FX.buildAtmosphere(PIXI, width, height, {
      accent: tuning.palette && tuning.palette.accent,
      secondary: tuning.palette && tuning.palette.secondary
    }, seed);
    this.atmosphereLayer.addChild(this.atmosphere.container);

    // 1d. 角标取景器：非对称、只画角不围合。与 1/1b 的框线错开边距（4.5% vs 8%/12%），
    // 两层各管各的：框线是「画幅」，角标是「机身」。
    this.markLayer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    this.markLayer.addChild(FX.buildCornerMarks(PIXI, width, height, {
      primary: tuning.palette && tuning.palette.primary,
      secondary: tuning.palette && tuning.palette.secondary
    }, seed));

    // 2. HUD 布景：轨道环系（orbital/orrery）或四种静态线稿，按种子六选一。
    this.hudContainer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    this.geoContainer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    this.giantText = null;
    this.orbits = [];
    var hud = new PIXI.Graphics();
    var i, j, part;

    if (this.backgroundKind === 'orbital' || this.backgroundKind === 'orrery') {
      // 五层独立局部坐标环：断弧反向缓转 + 刻度圈 + 环上卫星点。
      for (i = 0; i < 5; i += 1) {
        var orbit = new PIXI.Graphics();
        var orbitColor = i % 2 ? numPrimary : numSecondary;
        var r = radius * (0.4 + i * 0.17);
        for (var seg = 0; seg < 6; seg += 1) {
          var a0 = seg * Math.PI / 3 + i * 0.24;
          orbit.arc(0, 0, r, a0, a0 + Math.PI * (0.16 + i * 0.008));
          orbit.stroke({ color: orbitColor, width: i % 2 ? 1 : 2, alpha: 0.22 });
        }
        for (var tick = 0; tick < 36; tick += 1) {
          var a = tick * Math.PI / 18;
          var outer = r + (tick % 3 ? 4 : 11);
          orbit.moveTo(Math.cos(a) * r, Math.sin(a) * r)
            .lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        }
        orbit.stroke({ color: orbitColor, width: 1, alpha: 0.35 });
        orbit.circle(r, 0, 3).fill({ color: numTertiary, alpha: 0.8 });
        if (this.backgroundKind === 'orrery') {
          orbit.scale.y = 0.35 + i * 0.09;
          orbit.dataset = { flattened: orbit.scale.y };
        }
        orbit.position.set(cx, cy);
        this.hudContainer.addChild(orbit);
        this.orbits.push(orbit);
      }
      // 十字瞄准线 + 60° 扇形扫描区。
      hud.moveTo(cx - radius, cy).lineTo(cx + radius, cy);
      hud.moveTo(cx, cy - radius).lineTo(cx, cy + radius);
      hud.stroke({ color: numSecondary, width: 1, alpha: 0.25 });
      hud.moveTo(cx, cy);
      hud.arc(cx, cy, radius * 0.8, 0, Math.PI / 3);
      hud.lineTo(cx, cy);
      hud.fill({ color: numPrimary, alpha: 0.08 });
    } else {
      for (i = 0; i < 6; i += 1) {
        part = new PIXI.Graphics();
        var partColor = i % 2 ? numPrimary : numSecondary;
        if (this.backgroundKind === 'constellation') {
          // 星群折线：上下各三条随机游走链，节点实心圆。
          var px = -radius + rand() * radius * 2;
          var py = (i < 3 ? -1 : 1) * radius * (0.5 + rand() * 0.55);
          part.moveTo(px, py);
          for (j = 0; j < 5; j += 1) {
            var nx = px + (rand() - 0.4) * radius * 0.55;
            var ny = py + (rand() - 0.5) * radius * 0.35;
            part.lineTo(nx, ny).stroke({ color: partColor, width: 1, alpha: 0.28 });
            part.circle(nx, ny, j % 2 ? 2 : 4).fill({ color: numTertiary, alpha: 0.65 });
            part.moveTo(nx, ny);
            px = nx; py = ny;
          }
        } else if (this.backgroundKind === 'perspective') {
          // 嵌套矩形隧道：逐层放大 + 四角斜撑。
          var s = 0.24 + i * 0.19;
          var w = width * 0.43 * s, h = height * 0.39 * s;
          part.rect(-w, -h, w * 2, h * 2);
          [-1, 1].forEach(function (side) {
            part.moveTo(side * w, -h).lineTo(side * w * 1.18, -h * 1.18);
            part.moveTo(side * w, h).lineTo(side * w * 1.18, h * 1.18);
          });
          part.stroke({ color: partColor, width: 1.2, alpha: 0.3 });
        } else if (this.backgroundKind === 'wave-score') {
          // 六条声波谱线：双正弦叠加，粗细交替。
          for (j = 0; j <= 64; j += 1) {
            var wx = (j / 64 - 0.5) * width * 0.85;
            var wy = (i - 2.5) * radius * 0.3
              + Math.sin(j * 0.22 + i * 0.8) * radius * 0.13
              + Math.cos(j * 0.09 - i) * radius * 0.08;
            if (!j) part.moveTo(wx, wy); else part.lineTo(wx, wy);
          }
          part.stroke({ color: partColor, width: i % 2 ? 1 : 2, alpha: 0.25 });
        } else {
          // 社论格线：竖线 + 横刻度 + 随机长短线段。
          var lx = (i - 2.5) * width * 0.135;
          part.moveTo(lx, -radius).lineTo(lx, radius);
          for (j = 0; j < 7; j += 1) {
            var ly = (j - 3) * radius * 0.3;
            part.moveTo(lx - 10, ly).lineTo(lx + 10, ly);
            part.rect(lx + 15, ly - 3, 3 + rand() * 18, 6);
          }
          part.stroke({ color: partColor, width: 1, alpha: 0.32 });
        }
        part.position.set(cx, cy);
        this.hudContainer.addChild(part);
        this.orbits.push(part);
      }
    }
    this.hudContainer.addChild(hud);

    // 3. 巨型描边装饰字：本句前 8 字素，极低透明度漂在画面中央。
    var giantStr = line && line.fullText
      ? U.graphemes(line.fullText).slice(0, 8).join('') : 'SONNET';
    this.giantText = new PIXI.Text({
      text: giantStr,
      style: {
        fontFamily: this.fontStack,
        fontSize: Math.min(180, width * 0.22),
        fontWeight: '900',
        fill: 'transparent',
        stroke: { color: numSecondary, width: 2 },
        alpha: 0.12
      }
    });
    this.giantText.alpha = 0.12;
    this.giantText.anchor.set(0.5);
    this.giantText.position.set(cx, cy - 20);
    this.geoContainer.addChild(this.giantText);

    // 4. 正文排版 + 词组舞台 + 重音编舞。
    this.textContainer.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    this.motif = FX.buildMotif(PIXI, this.geoContainer, width, height, numTertiary, seed);
    this.motif.pivot.set(cx, cy);
    this.motif.position.set(cx, cy);
    this.words = FX.buildLyrics(PIXI, this.textContainer, line, width, height, tuning, seed, this.fontStack);
    this.phrases = FX.buildPhraseStage(PIXI, this.textContainer, this.words, numSecondary);
    if (this.accents) this.accents.destroy();
    this.accents = FX.createAccentChoreography(PIXI, this.textContainer, this.words, numTertiary, seed, numPrimary);
    this.scan = hud;
    this.scan.pivot.set(cx, cy);
    this.scan.position.set(cx, cy);
    if (tuning.lyricLayout !== 'editorial-track') this.sceneContainer.pivot.set(cx, cy);
    this.hudContainer.pivot.set(cx, cy);
    this.hudContainer.position.set(cx, cy);
  };

  SonnetDirector.prototype.update = function (frame, tuning) {
    if (!this.initialized || this.destroyed) return null;
    var FXp = tuning.performance = this.performance.update(frame, tuning, this.words);
    FX.applyQuality(this.app, this.width, this.height, tuning.quality);
    var motion = FX.motionScale(tuning);
    var time = frame.playbackTime;
    var kick = FXp.impact;
    var intensity = motion * FX.amount(tuning.performanceIntensity, 1.25);
    var trackMode = tuning.lyricLayout === 'editorial-track';
    var trackSeed = (frame.track && (frame.track.path || frame.track.title)) || 'sonnet-track';

    var camera = trackMode
      ? this.editorialTrack.update(frame, tuning, this.numPrimary, trackSeed, this.width, this.height)
      : FX.cameraPose(frame, tuning, this.activeKind, this.width, this.height, this.words);
    this.textContainer.visible = !trackMode;
    this.trackContainer.visible = trackMode;
    if (trackMode) {
      this.sceneContainer.pivot.set(camera.x, camera.y);
      this.sceneContainer.position.set(this.width / 2, this.height / 2);
    } else {
      this.sceneContainer.pivot.set(this.width / 2, this.height / 2);
      this.sceneContainer.position.set(camera.x, camera.y);
    }
    this.sceneContainer.scale.set(camera.scale);
    this.sceneContainer.rotation = camera.rotation;
    // 背景溶解交接不允许压暗歌词或闪断常驻外框。
    this.sceneContainer.alpha = 1;
    var fixedX = trackMode ? camera.x - this.width / 2 : 0;
    var fixedY = trackMode ? camera.y - this.height / 2 : 0;
    this.geoContainer.position.set(fixedX, fixedY);
    this.frameDecorContainer.position.set(fixedX, fixedY);
    this.hudContainer.position.set(this.width / 2 + fixedX, this.height / 2 + fixedY);

    var circular = this.backgroundKind === 'orbital' || this.backgroundKind === 'orrery';
    this.orbits.forEach(function (orbit, index) {
      orbit.visible = tuning.quality !== 'energy-saving' || index < 2;
      var direction = index % 2 ? -1 : 1;
      orbit.rotation = circular
        ? (time * (0.07 + index * 0.025) + kick * 0.15) * direction * intensity
        : Math.sin(time * 0.16 + index) * 0.012 * intensity;
      var depth = this.backgroundKind === 'perspective'
        ? Math.sin(time * 0.55 - index * 0.5) * 0.06 * intensity : 0;
      var scale = 1 + depth + kick * (0.025 + index * 0.015) * intensity;
      orbit.scale.set(scale, scale * ((orbit.dataset && orbit.dataset.flattened) || 1));
      orbit.position.set(this.width / 2,
        this.height / 2 + (circular ? 0 : Math.sin(time * 0.4 + index * 0.7) * 12 * intensity));
      orbit.alpha = 0.55 + FXp.energy * 0.35;
    }, this);
    // 尚未 buildShot（无歌词/未定位）时布景对象还不存在：跳过装饰驱动。
    if (this.scan) this.scan.rotation = time * 0.32 * intensity;
    if (this.motif) {
      this.motif.visible = circular;
      this.motif.rotation = -time * 0.035 * intensity;
      this.motif.scale.set(1 + Math.sin(time * 0.6) * 0.025 * intensity);
    }
    this.frameDecorContainer.scale.set(1 + kick * 0.008 * intensity);
    if (this.giantText) {
      this.giantText.alpha = this.backgroundKind === 'editorial-lattice' ? 0.12 : 0.055;
      this.giantText.scale.set(1 + FXp.energy * 0.06 * intensity);
      this.giantText.position.set(
        this.width * 0.5 + Math.sin(time * 0.14) * this.width * 0.12 * intensity,
        this.height * 0.5 - 20 + Math.cos(time * 0.19) * 18 * intensity);
      this.giantText.rotation = Math.sin(time * 0.12) * 0.035 * intensity;
    }

    if (!trackMode) {
      FX.animateLyrics(this.words, frame, tuning, this.numPrimary);
      FX.animatePhraseStage(this.phrases, frame, tuning, this.activeKind);
      if (this.accents) this.accents.update(frame, tuning);
    }

    this.hudContainer.visible = tuning.showBackground !== false && tuning.guideLines !== false;
    this.frameDecorContainer.visible = tuning.showDecor !== false;
    this.frameDecorContainer.alpha = tuning.backgroundMode === 'anime' ? 0.3 : 1;
    this.geoContainer.visible = tuning.showBackground !== false;
    var backgroundAlpha = this.retirement.update(frame, tuning);
    this.geoContainer.alpha = backgroundAlpha == null ? 1 : backgroundAlpha;
    this.hudContainer.alpha = this.geoContainer.alpha;
    // 角标与压边渐隐跟 geo 同步退场：切句时整套画面一起走，不留一层壳。
    this.markLayer.alpha = this.geoContainer.alpha;
    this.markLayer.visible = this.geoContainer.visible;
    // 氛围光不吃退场淡出（它是环境不是内容），但吃起音能量：重拍时空气会「亮一下」。
    if (this.atmosphere) this.atmosphere.update(time, motion, FXp.energy);
    // 图片背景模式：柔光必须收掉，否则会在照片上蒙一层彩色雾，且角落不再全透明
    // （契约要求图片模式至少 90% 像素完全透明、角落 alpha 为 0）。
    this.atmosphereLayer.visible = tuning.backgroundMode !== 'anime'
      && tuning.showBackground !== false && tuning.quality !== 'energy-saving';
    this.optical.setTint(tuning.palette && tuning.palette.accent);
    this.optical.update(frame, tuning, this.width, this.height);
    this.app.render();
    return camera;
  };

  SonnetDirector.prototype.getDebugSnapshot = function () {
    return {
      initialized: this.initialized, camera: this.activeKind, composition: this.backgroundKind,
      glyphs: this.words.length, phrases: this.phrases.length, orbits: this.orbits.length,
      performance: this.performance.snapshot(),
      accents: this.accents ? this.accents.snapshot() : null,
      editorial: this.editorialTrack ? this.editorialTrack.snapshot() : null,
      resolution: this.app && this.app.renderer ? this.app.renderer.resolution : null,
      halation: this.optical ? this.optical.halation.enabled : false,
      atmosphere: !!this.atmosphere,
      retirement: this.retirement ? this.retirement.snapshot() : null
    };
  };

  SonnetDirector.prototype.destroy = function () {
    if (this.destroyed && !this.app) return;
    this.destroyed = true;
    this.pendingShot = null;
    this.performance.reset();
    this.words = [];
    this.phrases = [];
    this.orbits = [];
    if (this.accents) { this.accents.destroy(); this.accents = null; }
    if (this.editorialTrack) { this.editorialTrack.destroy(); this.editorialTrack = null; }
    this.motif = this.scan = this.giantText = null;
    if (this.atmosphere) { this.atmosphere.destroy(); this.atmosphere = null; }
    if (this.retirement) { this.retirement.destroy(); this.retirement = null; }
    if (this.optical) { this.optical.destroy(); this.optical = null; }
    this.postProcess = null;
    // init 被打断时 initialized 尚未置位但渲染器可能已分配：无条件回收 WebGL 上下文。
    if (this.app && this.initialized) {
      try { this.app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true }); }
      catch (err) { console.warn('[stanza-sonnet] PIXI cleanup failed:', err); }
    }
    this.app = null;
    this.sceneContainer = this.geoContainer = this.hudContainer = null;
    this.atmosphereLayer = this.markLayer = null;
    this.frameDecorContainer = this.textContainer = this.trackContainer = null;
    this.initialized = false;
  };

  // ------------------------------------------------------------------
  // 社论轨（editorial-track）：整首歌的歌词排成横竖交替的「阅读路线」，
  // 镜头沿路线推进；只有活动行附近的一小窗持有显示对象。
  // ------------------------------------------------------------------

  function createEditorialTrack(PIXI, parent, fontStack) {
    var root = new PIXI.Container();
    var decor = new PIXI.Container();
    var text = new PIXI.Container();
    root.addChild(decor, text);
    parent.addChild(root);

    var entries = [], glyphs = [], layout = [];
    var source = null, signature = '';
    var activeIndex = -1, width = 1, height = 1, color = 0xffffff;

    function release() {
      decor.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
      text.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
      entries = [];
      glyphs = [];
    }

    // 路线编译：每行掷种子决定横排/竖排，三连同向后强制转弯，保证路线蜿蜒。
    function compileLayout(lines, seed, w, h, tuning) {
      var result = [];
      var x = w * 0.5, y = h * 0.48;
      var verticalChance = FX.amount(tuning.trackVerticalChance, 0.42, 0.9);
      var junction = FX.amount(tuning.trackJunction, 0.45, 1);
      lines.forEach(function (line, index) {
        var random = FX.seededRandom('editorial-track:' + seed + ':' + index + ':' + line.fullText);
        var vertical = random() < verticalChance;
        if (result.length >= 3) {
          var recent = result.slice(-3);
          if (recent.every(function (p) { return p.vertical === recent[0].vertical; })) {
            vertical = !recent[0].vertical;
          }
        }
        var turn = index > 0 && vertical !== result[index - 1].vertical;
        if (index > 0) {
          var sideStep = (random() - 0.5) * junction;
          if (vertical) {
            y += h * (0.39 + random() * 0.08);
            x += w * (turn ? 0.13 + sideStep * 0.09 : sideStep * 0.14);
          } else {
            x += w * (0.40 + random() * 0.08);
            y += h * (turn ? 0.12 + sideStep * 0.08 : sideStep * 0.13);
          }
        }
        result.push({
          x: x, y: y, vertical: vertical,
          rotation: (random() - 0.5) * 0.045 * junction,
          scale: 0.88 + random() * 0.16,
          labelSide: random() > 0.5 ? 1 : -1
        });
      });
      return result;
    }

    // 逗号/空格错栏：前后都够保底字数才断段，段间沿交叉轴错开。
    function segmentGlyphs(timed, minimumSegment) {
      var segmentByGlyph = new Array(timed.length).fill(0);
      var segment = 0, visibleBefore = 0;
      function countRemaining(startIndex) {
        var remaining = 0;
        for (var i = startIndex; i < timed.length; i += 1) {
          var t = timed[i].text;
          if (t.trim() && t !== ',' && t !== '，') remaining += 1;
        }
        return remaining;
      }
      timed.forEach(function (glyph, glyphIndex) {
        var text = glyph.text;
        var isComma = text === ',' || text === '，';
        var isBlank = !text.trim();
        segmentByGlyph[glyphIndex] = segment;
        if (!isComma && !isBlank) { visibleBefore += 1; return; }
        if (visibleBefore >= minimumSegment && countRemaining(glyphIndex + 1) >= minimumSegment) {
          segment += 1;
          visibleBefore = 0;
        }
      });
      return { segmentByGlyph: segmentByGlyph, segmentCount: segment + 1 };
    }

    function makeEntry(line, lineIndex, point, tuning, activeIndexNow) {
      var palette = tuning.palette || {};
      var secondary = colorNumber(palette.secondary, color);
      var tertiary = colorNumber(palette.tertiary, color);
      var entryRoot = new PIXI.Container();
      var entryDecor = new PIXI.Container();
      var entryText = new PIXI.Container();
      entryRoot.addChild(entryDecor, entryText);
      entryRoot.position.set(point.x, point.y);
      entryRoot.rotation = point.rotation;
      var timed = FX.compilePhrases(line, tuning);
      var visible = timed.filter(function (g) { return g.text.trim(); });
      var count = Math.max(1, visible.length);
      var minimumSegment = Math.round(FX.amount(tuning.trackMinSegment, 3, 8)) || 3;
      var seg = segmentGlyphs(timed, minimumSegment);
      var baseFontSize = Math.min(width * 0.065, height * 0.092, 66)
        * FX.amount(tuning.fontScale, 1, 1.5) * point.scale;
      var maxSpan = point.vertical ? height * 0.76 : width * 0.66;
      var minimumFontSize = Math.min(width, height) * 0.022;
      // 字距永不压到字身以下：长句先缩字号，避免竖排 CJK 叠字。
      var fontSize = Math.max(minimumFontSize, Math.min(baseFontSize, maxSpan / (count * 1.08)));
      var advance = fontSize * 1.08;
      var start = -(count - 1) * advance * 0.5;
      var segmentOffset = fontSize * (0.62 + FX.amount(tuning.trackJunction, 0.45, 1) * 0.7);
      var visibleIndex = 0;
      var nodes = timed.map(function (glyph, glyphIndex) {
        var node = new PIXI.Text({
          text: glyph.text,
          style: {
            fontFamily: fontStack, fontSize: fontSize, fontWeight: '750', fill: '#ffffff',
            stroke: { color: (tuning.palette && tuning.palette.background) || '#09090b',
              width: Math.max(1, fontSize * 0.022) }
          }
        });
        node.anchor.set(0.5);
        var blank = !glyph.text.trim();
        var ordinal = visibleIndex;
        if (!blank) visibleIndex += 1;
        var axis = start + ordinal * advance;
        var centeredSegment = seg.segmentByGlyph[glyphIndex] - (seg.segmentCount - 1) * 0.5;
        var crossAxis = centeredSegment * segmentOffset;
        var baseX = point.vertical ? crossAxis : axis;
        var baseY = point.vertical ? axis : crossAxis;
        node.position.set(baseX, baseY);
        node.visible = !blank;
        node.dataset = Object.assign({}, glyph, {
          index: glyphIndex, baseX: baseX, baseY: baseY,
          worldX: point.x + baseX, worldY: point.y + baseY,
          fontSize: fontSize, fit: 1, advance: advance,
          segment: seg.segmentByGlyph[glyphIndex],
          angle: ((glyphIndex % 5) - 2) * 0.035
        });
        entryText.addChild(node);
        return node;
      });

      var span = Math.max(fontSize * 1.5, (count - 1) * advance + fontSize * 1.35);
      var breadth = fontSize * 1.62 + Math.max(0, seg.segmentCount - 1) * segmentOffset;
      var left = point.vertical ? -breadth * 0.5 : -span * 0.5;
      var top = point.vertical ? -span * 0.5 : -breadth * 0.5;
      var boxWidth = point.vertical ? breadth : span;
      var boxHeight = point.vertical ? span : breadth;
      point.halfW = boxWidth / 2;
      point.halfH = boxHeight / 2;
      // 四角括标框住每个站点。
      var graphic = new PIXI.Graphics();
      var corner = Math.min(18, breadth * 0.24);
      graphic.moveTo(left + corner, top).lineTo(left, top).lineTo(left, top + corner);
      graphic.moveTo(left + boxWidth - corner, top).lineTo(left + boxWidth, top).lineTo(left + boxWidth, top + corner);
      graphic.moveTo(left, top + boxHeight - corner).lineTo(left, top + boxHeight).lineTo(left + corner, top + boxHeight);
      graphic.moveTo(left + boxWidth - corner, top + boxHeight).lineTo(left + boxWidth, top + boxHeight)
        .lineTo(left + boxWidth, top + boxHeight - corner);
      graphic.stroke({ color: secondary, width: 1.25, alpha: 0.52 });
      entryDecor.addChild(graphic);

      var marker = new PIXI.Text({
        text: ('0' + (lineIndex + 1)).slice(-2) + ' / ' + (point.vertical ? 'VERTICAL' : 'HORIZONTAL'),
        style: { fontFamily: '"IBM Plex Mono","SFMono-Regular",Consolas,monospace',
          fontSize: Math.max(9, fontSize * 0.16), fontWeight: '600', letterSpacing: 2, fill: '#ffffff' }
      });
      marker.tint = secondary;
      marker.alpha = 0.64;
      marker.position.set(left, top - Math.max(14, fontSize * 0.28));
      entryDecor.addChild(marker);

      // 活动行站点：三落点 × 四臂螺旋粒子（与主舞台同款汇聚语言）。
      var accentLayer = new PIXI.Container();
      entryRoot.addChild(accentLayer);
      var accent = { layer: accentLayer, particles: [] };
      if (lineIndex === activeIndexNow) {
        var targets = nodes.filter(function (n) { return n.visible; })
          .filter(function (n, i, list) { return i % Math.max(1, Math.floor(list.length / 3)) === 0; })
          .slice(0, 3);
        var random = FX.seededRandom('track-accent:' + lineIndex + ':' + line.fullText);
        targets.forEach(function (target) {
          for (var arm = 0; arm < 4; arm += 1) {
            var trail = [];
            for (var dotIndex = 0; dotIndex < 14; dotIndex += 1) {
              var dot = new PIXI.Graphics().circle(0, 0, dotIndex ? 1.5 : 3).fill({ color: tertiary, alpha: 1 });
              accentLayer.addChild(dot);
              trail.push(dot);
            }
            accent.particles.push({
              target: target, arm: arm, trail: trail,
              angle: random() * Math.PI * 2 + arm * Math.PI * 0.5,
              direction: arm % 2 ? -1 : 1,
              reach: fontSize * (2.8 + random() * 1.7)
            });
          }
        });
      }
      accentLayer.visible = false;
      return { root: entryRoot, nodes: nodes, line: line, lineIndex: lineIndex,
        point: point, entryDecor: entryDecor, entryText: entryText, accent: accent };
    }

    function rebuild(frame, tuning, nextColor, seed) {
      release();
      source = frame.lines;
      activeIndex = frame.currentLineIndex;
      color = nextColor;
      layout = compileLayout(frame.lines, seed, width, height, tuning);
      var before = tuning.quality === 'energy-saving' ? 1 : 2;
      var after = tuning.quality === 'energy-saving' ? 2 : 4;
      var first = Math.max(0, activeIndex - before);
      var last = Math.min(frame.lines.length - 1, Math.max(activeIndex, 0) + after);
      for (var index = first; index <= last; index += 1) {
        var entry = makeEntry(frame.lines[index], index, layout[index], tuning, activeIndex);
        text.addChild(entry.root);
        entries.push(entry);
        glyphs.push.apply(glyphs, entry.nodes);
      }
      // 稀疏拐点标记暗示路线延续，不画实线铁轨。
      for (var j = Math.max(1, first); j <= last; j += 1) {
        var a = layout[j - 1], b = layout[j];
        var elbowX = b.vertical ? b.x : a.x;
        var elbowY = b.vertical ? a.y : b.y;
        var junction = new PIXI.Graphics();
        junction.moveTo(a.x, a.y).lineTo(elbowX, elbowY).lineTo(b.x, b.y);
        junction.stroke({ color: colorNumber(tuning.palette && tuning.palette.secondary, color), width: 1, alpha: 0.24 });
        var tickSize = Math.min(width, height) * 0.012;
        junction.moveTo(elbowX - tickSize, elbowY).lineTo(elbowX + tickSize, elbowY);
        junction.moveTo(elbowX, elbowY - tickSize).lineTo(elbowX, elbowY + tickSize);
        junction.stroke({ color: colorNumber(tuning.palette && tuning.palette.tertiary, color), width: 1, alpha: 0.42 });
        decor.addChild(junction);
      }
    }

    return {
      update: function (frame, tuning, nextColor, seed, nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        var nextSignature = [seed, width, height, tuning.fontScale, tuning.trackVerticalChance,
          tuning.trackJunction, tuning.trackMinSegment, tuning.quality, nextColor,
          JSON.stringify(tuning.palette)].join(':');
        if (source !== frame.lines || activeIndex !== frame.currentLineIndex || signature !== nextSignature) {
          signature = nextSignature;
          rebuild(frame, tuning, nextColor, seed);
        }
        if (activeIndex < 0 || !layout[activeIndex]) {
          root.visible = false;
          return { x: width / 2, y: height / 2, scale: 1, rotation: 0, glyphs: glyphs };
        }
        root.visible = true;
        decor.visible = tuning.showDecor !== false && tuning.backgroundMode !== 'anime';
        var time = frame.playbackTime;
        var motion = FX.motionScale(tuning);
        var glyphStrength = FX.amount(tuning.typographyMotion, 1) * motion;
        var ink = parseInt(String((tuning.palette && tuning.palette.ink) || '#f4f4f5').slice(1), 16);
        entries.forEach(function (entry) {
          entry.entryDecor.visible = tuning.showDecor !== false;
          entry.entryDecor.alpha = tuning.backgroundMode === 'anime' ? 0.35 : 1;
          var relative = entry.lineIndex - activeIndex;
          // 未唱到的站点按「距开唱的秒数」渐次铺路，唱过的退成暗色残影。
          var lead = Math.max(0.8, Math.min(4.5,
            entry.line.startTime - (frame.activeLine ? frame.activeLine.startTime : time)));
          var paved = relative <= 0 ? 1 : FX.ease(1 - (entry.line.startTime - time) / lead);
          var retired = relative < 0 ? Math.max(0.12, 0.42 - Math.abs(relative) * 0.11) : 1;
          entry.root.alpha = paved * retired;
          entry.root.scale.set(0.94 + paved * 0.06);
          entry.nodes.forEach(function (node) {
            var d = node.dataset;
            var p = FX.clamp((time - d.startTime) / Math.max(0.04, d.endTime - d.startTime), 0, 1);
            var arrival = 1 - FX.expo((time - d.startTime + 0.18) / 0.52);
            var active = time >= d.startTime && time < d.endTime;
            var offsetX, offsetY;
            if (tuning.glyphStyle === 'scatter') {
              var direction = d.index % 2 ? 1 : -1;
              offsetX = direction * arrival * d.fontSize * 0.72;
              offsetY = -direction * arrival * d.fontSize * 0.48;
            } else {
              offsetX = entry.point.vertical ? arrival * d.fontSize * 0.7 : 0;
              offsetY = entry.point.vertical ? 0 : arrival * d.fontSize * 0.7;
            }
            node.position.set(d.baseX + offsetX * glyphStrength, d.baseY + offsetY * glyphStrength);
            node.rotation = tuning.glyphStyle === 'scatter' ? d.angle * arrival * glyphStrength : 0;
            var activePulse = active ? Math.sin(p * Math.PI) * 0.08 : 0;
            var entryScale = tuning.glyphStyle === 'impact' ? arrival * 0.48 : arrival * 0.16;
            node.scale.set(Math.max(0.28, 1 - entryScale * glyphStrength + activePulse * glyphStrength));
            node.alpha = time < d.startTime ? FX.amount(tuning.waitingOpacity, 0.25, 1) : 1;
            node.tint = active && tuning.textInversion !== false ? nextColor : ink;
          });

          var accentEnabled = entry.lineIndex === activeIndex
            && tuning.accentEffects !== false && tuning.showDecor !== false && glyphStrength > 0
            && FX.accentCues(frame.lines, 'sonnet:' + seed).has(activeIndex);
          var accent = entry.accent;
          accent.layer.visible = accentEnabled;
          if (accentEnabled) {
            accent.particles.forEach(function (particle) {
              var d = particle.target.dataset;
              var arrivalTime = d.startTime + Math.min(0.12, (d.endTime - d.startTime) * 0.3);
              var duration = Math.min(1.45, Math.max(0.35, arrivalTime - entry.line.startTime));
              var travel = (time - arrivalTime + duration) / duration;
              var armBudget = tuning.quality === 'ultimate' ? 4
                : tuning.quality === 'energy-saving' ? 2 : 3;
              particle.trail.forEach(function (dot, dotIndex) {
                var u = travel - dotIndex * 0.018;
                dot.visible = particle.arm < armBudget && u >= 0 && u <= 1
                  && (tuning.quality !== 'energy-saving' || dotIndex < 8);
                if (!dot.visible) return;
                var turn = (1 - u) * Math.PI * 2.35;
                var radius = (1 - FX.ease(u)) * particle.reach * Math.min(1.5, glyphStrength);
                dot.position.set(
                  d.baseX + Math.cos(particle.angle + turn * particle.direction) * radius,
                  d.baseY + Math.sin(particle.angle + turn * particle.direction) * radius * 0.84);
                dot.alpha = FX.ease(u / 0.08) * (1 - dotIndex / particle.trail.length)
                  * (particle.arm ? 0.55 : 0.85);
              });
            });
          }
        });

        // 阅读镜头：沿当前站点主轴推进，行尾提前拐向下一站点入口。
        var point = layout[activeIndex];
        var hasNext = activeIndex + 1 < layout.length;
        var next = hasNext ? layout[activeIndex + 1] : point;
        var lookAhead = FX.amount(tuning.trackLookAhead, 0.38, 1);
        var lineProgress = FX.ease(frame.lineProgress || 0);
        var axisSpan = (point.vertical ? height : width) * 0.13;
        var readingX = point.x + (point.vertical ? 0 : axisSpan * (lineProgress * 2 - 1));
        var readingY = point.y + (point.vertical ? axisSpan * (lineProgress * 2 - 1) : 0);
        var nextSpan = (next.vertical ? height : width) * 0.13;
        var nextStartX = next.x + (next.vertical ? 0 : -nextSpan);
        var nextStartY = next.y + (next.vertical ? -nextSpan : 0);
        var junctionDuration = 0.18 + lookAhead * 0.42;
        var junctionProgress = hasNext
          ? FX.ease((lineProgress - (1 - junctionDuration)) / junctionDuration) : 0;
        var focusX = readingX + (nextStartX - readingX) * junctionProgress;
        var focusY = readingY + (nextStartY - readingY) * junctionProgress;
        var tracking = FX.amount(tuning.cameraTracking, 0.35, 1);
        var breath = Math.sin(time * 0.43) * 0.012 * FX.amount(tuning.cameraBreath, 0.5) * motion;
        return {
          x: focusX, y: focusY,
          scale: 1.02 + tracking * 0.08 + breath,
          rotation: -point.rotation * FX.amount(tuning.cameraRoll, 0.25, 1) * motion,
          glyphs: glyphs
        };
      },
      destroy: function () {
        release();
        root.removeFromParent();
        root.destroy({ children: true });
        source = null;
        layout = [];
      },
      snapshot: function () {
        return { trackEntries: entries.length, trackGlyphs: glyphs.length, trackActive: activeIndex };
      },
      // 站点框（世界坐标 + 半盒）：寻句热区用。窗口外的行只有布局点，给默认半盒。
      layoutPoint: function (index) {
        var point = layout[index];
        if (!point) return null;
        return { x: point.x, y: point.y,
          halfW: point.halfW || Math.min(width, height) * 0.08,
          halfH: point.halfH || Math.min(width, height) * 0.05 };
      }
    };
  }

  // ------------------------------------------------------------------
  // 渲染器外壳：与 classic/cadenza 相同的 API。DOM 层只有角标文案、HUD
  // 读数与寻句热区；画面主体全在 Pixi canvas。
  // ------------------------------------------------------------------

  function init(host, onSeek) {
    var root = document.createElement('div');
    root.className = 'fl-sonnet';
    root.hidden = true;

    var eyebrow = document.createElement('div');
    eyebrow.className = 'fl-sonnet-eyebrow';
    eyebrow.textContent = 'SONNET · 商籁';
    var hud = document.createElement('div');
    hud.className = 'fl-sonnet-hud';
    var emptyEl = document.createElement('div');
    emptyEl.className = 'fl-empty';
    emptyEl.hidden = true;
    root.append(eyebrow, hud, emptyEl);

    // 寻句热区：主舞台模式盖当前行+后两行的排版包围盒；社论轨模式盖站点框。
    var hotspots = [0, 1, 2].map(function () {
      var el = document.createElement('div');
      el.className = 'fl-sonnet-hot';
      el.hidden = true;
      root.appendChild(el);
      return el;
    });

    host.append(root);

    var director = new SonnetDirector(root, onSeek);
    var theme = global.StanzaTheme ? StanzaTheme.resolveSonnet(1.35) : { backgroundColor: '#09090b', primaryColor: '#f4f4f5', accentColor: '#f4f4f5', secondaryColor: '#71717a', animationIntensity: 'normal', fontStyle: 'sans' };
    var fontScale = 1, visible = false, eco = false, reduced = false;
    var motion = 0.65, reactivity = 1.35;
    var bgMode = 'stage', vignette = true;
    var tuning = { shotFlow: 'auto', lyricLayout: 'phrases', phraseLength: 12, decor: true, accents: true };
    var destroyed = false;
    var initStarted = false, initFailed = false;
    var renderedKey = '';
    var lastHudText = '';
    var themeSig = '';
    var ro = null;

    function accentRgb() {
      var c = U.hexToRgb(theme.accentColor) || { r: 244, g: 244, b: 245 };
      return c;
    }

    function engineTuning(frame) {
      var imageMode = bgMode === 'anime';
      return {
        palette: { background: theme.backgroundColor, ink: theme.primaryColor,
          accent: theme.accentColor, secondary: theme.secondaryColor,
          tertiary: theme.tertiaryColor || theme.accentColor },
        backgroundMode: bgMode,
        fontScale: fontScale,
        lyricMotion: 'sonnet',
        shotFlow: tuning.shotFlow,
        lyricLayout: tuning.lyricLayout,
        phraseLength: tuning.phraseLength,
        // 舞台「镜头动态」滑杆直接驱动商籁镜头强度（0–2）。
        cameraIntensity: motion * 2,
        animationIntensity: frame && frame.reduced ? 0
          : (theme.animationIntensity === 'calm' ? 0.6 : theme.animationIntensity === 'chaotic' ? 1.6 : 1),
        performanceIntensity: reactivity,
        quality: eco ? 'energy-saving' : 'high',
        reducedMotion: reduced,
        showBackground: !imageMode && (bgMode !== 'stage' || tuning.decor),
        guideLines: !imageMode && tuning.decor,
        showDecor: tuning.decor,
        accentEffects: !imageMode && tuning.accents,
        waitingOpacity: imageMode ? 0.55 : 0.42,
        postProcess: !imageMode,
        vignette: vignette && !imageMode ? 0.18 : 0,
        opticalImpact: 0.65,
        sceneTransitions: !imageMode,
        textInversion: true
      };
    }

    function shotKey(frame) {
      var line = frame.activeLine;
      var trackId = (frame.track && (frame.track.id || frame.track.title)) || '';
      return [trackId, line ? line.startTime : 'none', line ? line.fullText : '',
        tuning.shotFlow, tuning.lyricLayout, tuning.phraseLength, fontScale, themeSig].join('|');
    }

    function updateHotspots(frame, camera) {
      if (!camera || !frame.activeLine) {
        hotspots.forEach(function (h) { h.hidden = true; });
        return;
      }
      var trackMode = tuning.lyricLayout === 'editorial-track';
      // 主舞台一次只排当前句，故只给当前句热区；社论轨把邻近站点也画出来了，
      // 才可以给它们各自的热区（否则热区会指向屏幕上的空白处）。
      var list = trackMode
        ? [frame.activeLine].concat(frame.nextLines.slice(0, 2))
        : [frame.activeLine];
      // 世界坐标 → 屏幕坐标：与 sceneContainer 的 pivot/position/scale/rotation 同式。
      var cos = Math.cos(camera.rotation), sin = Math.sin(camera.rotation);
      var pivotX = trackMode ? camera.x : director.width / 2;
      var pivotY = trackMode ? camera.y : director.height / 2;
      var posX = trackMode ? director.width / 2 : camera.x;
      var posY = trackMode ? director.height / 2 : camera.y;
      function toScreen(wx, wy) {
        var dx = (wx - pivotX) * camera.scale, dy = (wy - pivotY) * camera.scale;
        return { x: posX + dx * cos - dy * sin, y: posY + dx * sin + dy * cos };
      }
      hotspots.forEach(function (el, i) {
        var line = list[i];
        var bounds = line && U.hasReadable(line.fullText)
          ? (trackMode ? trackBounds(line) : activeLineBounds())
          : null;
        if (!bounds) { el.hidden = true; return; }
        var c = toScreen(bounds.cx, bounds.cy);
        var w = Math.max(64, bounds.halfW * 2 * camera.scale);
        var h = Math.max(40, bounds.halfH * 2 * camera.scale);
        el.hidden = false;
        el.style.transform = 'translate(' + (c.x - w / 2) + 'px,' + (c.y - h / 2) + 'px)';
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        el.onclick = function (e) {
          e.stopPropagation();
          if (onSeek) onSeek(Math.round(line.startTime * 1000));
        };
      });
    }

    // 当前句字素的世界包围盒（baseX/baseY ± 字号半径）。
    function activeLineBounds() {
      var nodes = director.words;
      if (!nodes || !nodes.length) return null;
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        var d = n.dataset;
        var r = d.fontSize * d.fit * 0.75;
        minX = Math.min(minX, d.baseX - r); maxX = Math.max(maxX, d.baseX + r);
        minY = Math.min(minY, d.baseY - r); maxY = Math.max(maxY, d.baseY + r);
      });
      if (minX === Infinity) return null;
      return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
        halfW: (maxX - minX) / 2, halfH: (maxY - minY) / 2 };
    }
    // 社论轨：站点框用世界坐标（makeEntry 已把半盒写回布局点）。
    function trackBounds(line) {
      var track = director.editorialTrack;
      var pt = track && track.layoutPoint ? track.layoutPoint(line.index) : null;
      if (!pt) return null;
      return { cx: pt.x, cy: pt.y, halfW: pt.halfW, halfH: pt.halfH };
    }

    var lastEmptyText = '';
    function syncEmpty(frame) {
      var wantEmpty = !frame.activeLine;
      emptyEl.hidden = !wantEmpty;
      if (!wantEmpty) { lastEmptyText = ''; return; }
      var msg = frame.track ? '暂无歌词 · 让旋律继续' : '在声音里，发现另一片宇宙';
      if (msg !== lastEmptyText) {
        lastEmptyText = msg;
        emptyEl.style.color = theme.secondaryColor;
        emptyEl.style.fontSize = 'clamp(' + (1.5 * fontScale).toFixed(3) + 'rem,' +
          (3.5 * fontScale).toFixed(3) + 'vw,' + (2.25 * fontScale).toFixed(3) + 'rem)';
        emptyEl.textContent = msg;
      }
    }

    function frame() {
      if (destroyed || !visible || !global.Stage) return;
      var f = buildFrame(root);
      reduced = f.reduced;
      syncEmpty(f);
      if (!director.initialized) {
        if (!initStarted && !initFailed) {
          initStarted = true;
          director.init().catch(function (err) {
            initFailed = true;
            console.warn('[stanza-sonnet] 图形引擎不可用：', err);
            hud.textContent = '图形引擎不可用 · 请切换其他歌词视觉';
          });
        }
        return;
      }
      if (initFailed) return;
      director.resize();
      var key = shotKey(f);
      if (key !== renderedKey) {
        renderedKey = key;
        if (f.activeLine) {
          var seed = ((f.track && (f.track.id || f.track.title)) || 'sonnet') + ':' + f.activeLine.startTime;
          director.buildShot(f.activeLine, seed, accentRgb(), engineTuning(f));
        }
      }
      var camera = director.update(f, engineTuning(f));
      updateHotspots(f, camera);
      var hudText = f.activeLine
        ? 'FRAME ' + ('0' + (f.currentLineIndex + 1)).slice(-2)
          + '  /  AUDIO ' + Math.round(U.clamp(f.audio.power, 0, 1) * 100) + '%'
        : '';
      if (hudText !== lastHudText) { hud.textContent = hudText; lastHudText = hudText; }
    }

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { director.resize(); });
      ro.observe(root);
    }

    return {
      frame: frame,
      // 8fps 元数据 gate：行切换由 frame 依据 shotKey 自行检测，这里无事可做。
      update: function () {},
      setTheme: function (t) {
        if (!t) return;
        var sig = global.StanzaTheme ? StanzaTheme.signature(t) : JSON.stringify(t);
        if (sig === themeSig) return;
        theme = t;
        themeSig = sig;
        renderedKey = '';
        lastEmptyText = '';
        eyebrow.style.color = t.secondaryColor;
        hud.style.color = t.accentColor;
      },
      setFontScale: function (v) {
        v = U.clamp(v, 0.7, 1.5);
        if (Math.abs(v - fontScale) < 1e-6) return;
        fontScale = v;
        renderedKey = '';
      },
      setVisible: function (b) {
        visible = !!b;
        root.hidden = !visible;
        if (visible) {
          // 首次可见才申请 WebGL：其余布局不为商籁付任何初始化成本。
          if (!initStarted && !initFailed) frame();
          if (global.Stage && Stage.kick) Stage.kick();
        } else {
          hotspots.forEach(function (h) { h.hidden = true; });
        }
      },
      // 商籁的所有运动都是播放时钟的绝对时间函数：暂停时 Stage.position() 停走，
      // 环转/呼吸/镜头自然冻结在当前帧，无需额外的 paused 状态（spec 10.3）。
      setPaused: function () {},
      setEco: function (b) { eco = !!b; },
      setTuning: function (t) {
        if (!t) return;
        var next = {
          shotFlow: FX.SHOT_KINDS.indexOf(t.shotFlow) >= 0 ? t.shotFlow : 'auto',
          lyricLayout: ['phrases', 'lines', 'staircase', 'editorial-track'].indexOf(t.lyricLayout) >= 0
            ? t.lyricLayout : 'phrases',
          phraseLength: Math.round(U.clamp(U.num(t.phraseLength, 12), 4, 24)),
          decor: t.decor !== false,
          accents: t.accents !== false
        };
        if (next.shotFlow === tuning.shotFlow && next.lyricLayout === tuning.lyricLayout
          && next.phraseLength === tuning.phraseLength && next.decor === tuning.decor
          && next.accents === tuning.accents) return;
        tuning = next;
        renderedKey = '';
      },
      // stage3d 全局滑杆/开关的旁路推送（与 setTuning 分开，来源不同）。
      setMotion: function (v) { motion = U.clamp(U.num(v, 0.65), 0, 1); },
      setReactivity: function (v) { reactivity = U.clamp(U.num(v, 1.35), 0, 2); },
      setBgMode: function (m) { bgMode = m; },
      setVignette: function (b) { vignette = !!b; },
      resize: function () { director.resize(); },
      getDebugSnapshot: function () { return director.getDebugSnapshot(); },
      destroy: function () {
        destroyed = true;
        if (ro) { ro.disconnect(); ro = null; }
        director.destroy();
        root.remove();
      }
    };
  }

  // loadPixi / buildFrame 对外只读暴露：凝彩 tempera 与商籁共用同一份 Pixi
  // 惰性加载（全页只注入一次 <script>）与同一套 Stage → 帧适配（含行缓存）。
  global.StanzaSonnet = { init: init, loadPixi: loadPixi, buildFrame: buildFrame };
})(window);
