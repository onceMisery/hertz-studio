// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 离线提示词编译器：把一句中文/英文描述确定性地编译成 StageIntent。
//
// 这一层只做一件事：文本 → 规则匹配 → 意图。它没有 DOM、没有存储、没有网络、
// 没有随机数 —— 相同的输入和相同的舞台 schema 必须得到深相等的结果。它是
// 「文本编译」的唯一所有者：词典、优先级、否定与组合规则只住在这里，不进
// workshop.js，也不进渲染器。
//
// 它刻意不持有任何舞台 schema。参数路径、范围、场景默认值的唯一权威是
// CreativeGL 的场景描述和 CreativeStage 的基础参数：这里每次编译现读合法
// 的场景与路径（或接受调用方注入的 context），规则表里只存"语义 → 意图"。
// 若在这里复制一份 BASE_SPEC，词典就会在参数表演进时静默失配 —— 那是
// 第二份 schema，属于本模块最要防的事故。
//
// 产出是窄协议 StageIntent v1（见 creative-stage.js 的 applyIntent）：
//
//   { version: 1, scene?, patch?, director?, hand?, ruleIds }
//
// 编译器不产出完整预置。场景默认值、参数钳位、预置持久化与渲染写入全部
// 留给唯一的舞台状态所有者 CreativeStage，本模块永远不直接碰 preset。

(function () {
  'use strict';

  // 输入上限与工坊一致。截断按 Unicode code point
  // 数（不是 UTF-16 单元），所以emoji、生僻字都算一个字。
  var MAX_CHARS = 512;

  // 命中区间移除后要删掉的停用词：它们是请求的"包装纸"，不是效果。
  var STOPWORDS = {
    '的': 1, '一个': 1, '一种': 1, '和': 1, '与': 1, '还有': 1,
    '请': 1, '要': 1, '想要': 1, '风格': 1, '舞台': 1, '新舞台': 1,
    '创建': 1, '新建': 1, '新场景': 1, '制作': 1, '做一个': 1, '打造': 1,
    '创作': 1, '生成': 1,
    'the': 1, 'a': 1, 'an': 1, 'and': 1, 'with': 1, 'create': 1,
    'new': 1, 'fresh': 1, 'build': 1, 'make': 1, 'generate': 1
  };

  // 归一化白名单：ASCII 字母数字、CJK 统一表意（含扩展 A）之外的字符一律
  // 视为分隔符换成空格。与其枚举中英文标点（永远枚举不全），不如只保留
  // 可能出现在别名里的东西 —— 全角字符先经 NFKC 落回 ASCII，再走到这里。
  var KEEP_RE = /[^0-9A-Za-z_\u3400-\u4DBF\u4E00-\u9FFF\uE000\uE001]+/g;

  // -------------------------------------------------------------------------
  // 规则表
  //
  // 每条规则 = { id, group, label, aliases, apply }。apply() 返回效果对象
  // { scene? / patch? / director? / hand? }，值都是常量，首期不允许自由数值。
  // 别名在模块初始化时做重复检查：两个规则抢同一个词是词典事故，宁可开发期
  // 抛错，也不要运行期"最后加载的赢了"这种说不清的行为。
  //
  // 场景规则从 CreativeGL 描述派生，只写 scene；默认值仍由 CreativeStage 消费定义后应用。
  // -------------------------------------------------------------------------

  var RULES = [
    // --- 能量（氛围：整体的运动量与影调基准） --------------------------------
    { id: 'energy.quiet', group: 'energy', label: '安静',
      aliases: ['安静', '舒缓', '轻柔', 'quiet', 'calm'],
      apply: function () {
        return { patch: { 'cam.drift': 12, 'cam.shake': 15, 'cam.kick': 35,
          'look.bloom': 0.55, 'look.saturation': 0.9, 'stage.scale': 0.92 } };
      } },
    { id: 'energy.pulse', group: 'energy', label: '律动',
      aliases: ['律动', '强烈节拍', '节奏感', 'pulse', 'beat'],
      apply: function () {
        return { patch: { 'cam.drift': 65, 'cam.shake': 95, 'cam.kick': 120,
          'look.bloom': 1.3, 'look.saturation': 1.2, 'stage.scale': 1.05 } };
      } },
    { id: 'energy.explosive', group: 'energy', label: '爆发',
      aliases: ['爆发', '炸裂', 'explosive', 'burst'],
      apply: function () {
        return { patch: { 'cam.drift': 105, 'cam.shake': 155, 'cam.kick': 165,
          'look.bloom': 1.8, 'look.chroma': 0.8, 'look.saturation': 1.35,
          'stage.scale': 1.18 } };
      } },

    // --- 镜头（含运动速度；slow/fast 与 energy 都写 drift/shake，
    //     跨组冲突由合并顺序裁决：镜头在后，镜头胜出） --------------------------
    { id: 'camera.close', group: 'camera', label: '近景',
      aliases: ['近景', 'close'],
      apply: function () { return { patch: { 'cam.dist': 9 } }; } },
    { id: 'camera.far', group: 'camera', label: '远景',
      aliases: ['远景', 'far'],
      apply: function () { return { patch: { 'cam.dist': 24 } }; } },
    { id: 'camera.wide', group: 'camera', label: '广角',
      aliases: ['广角', 'wide'],
      apply: function () { return { patch: { 'cam.fov': 72 } }; } },
    { id: 'motion.slow', group: 'camera', label: '缓慢',
      aliases: ['缓慢镜头', '缓慢', '慢速', 'slow'],
      apply: function () { return { patch: { 'cam.drift': 18, 'cam.shake': 25 } }; } },
    { id: 'motion.fast', group: 'camera', label: '高速',
      aliases: ['高速镜头', '高速', '快速', 'fast'],
      apply: function () { return { patch: { 'cam.drift': 115, 'cam.shake': 130 } }; } },

    // --- 影调 ----------------------------------------------------------------
    { id: 'look.neon', group: 'look', label: '霓虹',
      aliases: ['霓虹', 'neon'],
      apply: function () {
        return { patch: { 'look.grade': 3, 'look.bloom': 1.55,
          'look.chroma': 0.75, 'look.saturation': 1.35 } };
      } },
    { id: 'look.mono', group: 'look', label: '单色',
      aliases: ['单色', '黑白', 'mono'],
      apply: function () {
        return { patch: { 'look.grade': 2, 'look.saturation': 0.1,
          'look.grain': 0.22 } };
      } },
    { id: 'look.duotone', group: 'look', label: '双色',
      aliases: ['双色', '双色调', 'duotone'],
      apply: function () {
        return { patch: { 'look.grade': 1, 'look.saturation': 1.05 } };
      } },
    { id: 'look.film', group: 'look', label: '胶片',
      aliases: ['胶片', '胶片感', 'film'],
      apply: function () {
        return { patch: { 'look.grain': 0.55, 'look.vignette': 0.42,
          'look.bloom': 0.75 } };
      } },
    { id: 'look.clean', group: 'look', label: '干净',
      aliases: ['干净', 'clean'],
      apply: function () {
        return { patch: { 'look.grain': 0, 'look.chroma': 0,
          'look.vignette': 0.18 } };
      } },

    // --- 手绘 / 导演 ----------------------------------------------------------
    { id: 'hand.on', group: 'hand', label: '手绘',
      aliases: ['手绘风格', '手绘', '纸张', 'hand drawn'],
      apply: function () {
        return { hand: { on: true },
          patch: { 'look.toon': 0.75, 'look.paper': 0.65 } };
      } },
    { id: 'hand.off', group: 'hand', label: '不要手绘',
      aliases: ['不要手绘', '不启用手绘', '不启用手绘覆盖层', '不开手绘效果',
        '不要启用手绘覆盖层', '关闭手绘', '关闭手绘覆盖层', '手绘不是开而是关',
        'no hand drawn', 'without hand drawn overlays',
        'leave hand drawing off'],
      apply: function () {
        return { hand: { on: false },
          patch: { 'look.toon': 0, 'look.paper': 0 } };
      } },
    { id: 'director.follow', group: 'director', label: '跟随音乐',
      aliases: ['跟随音乐', '跟着音乐', '自动导演', '开启自动导演', '开导演',
        '开启导演', 'follow music', 'auto director'],
      apply: function () { return { director: true }; } },
    { id: 'director.fixed', group: 'director', label: '固定镜头',
      aliases: ['固定镜头', '手动', '关闭自动导演', '关闭导演', '自动导演明确关闭',
        '导演明确关闭', 'fixed camera', 'manual',
        'disable the automatic director', 'keep auto direction disabled'],
      apply: function () { return { director: false }; } },

    // --- 否定覆盖：最后合并，永远压过前面各组写下的同参数值 --------------------
    { id: 'negative.shake', group: 'negative', label: '不要抖动',
      aliases: ['不要抖动', '不要镜头抖动', '关闭镜头抖动', '需要稳住镜头', '稳住镜头',
        '抖动值必须为零', 'no shake', 'no camera shake', 'shake value must be zero'],
      apply: function () { return { patch: { 'cam.shake': 0 } }; } },
    { id: 'negative.drift', group: 'negative', label: '不要镜头漂移',
      aliases: ['不要镜头漂移', '不要任何镜头漂移', '禁止镜头漂移', '禁止漂移',
        'no drift', 'camera drift must be disabled'],
      apply: function () { return { patch: { 'cam.drift': 0 } }; } },
    { id: 'negative.kick', group: 'negative', label: '不要低频跟随',
      aliases: ['禁止镜头 kick', 'no camera kick'],
      apply: function () { return { patch: { 'cam.kick': 0 } }; } },
    { id: 'negative.grain', group: 'negative', label: '不要颗粒',
      aliases: ['不要颗粒', '不要噪点', '完全去掉颗粒噪声', 'no grain',
        'do not add grain', 'set look grain to zero'],
      apply: function () { return { patch: { 'look.grain': 0 } }; } },
    { id: 'negative.bloom', group: 'negative', label: '不要泛光',
      aliases: ['不要泛光', '不要光晕', '关闭 bloom 光晕', '关闭泛光',
        'without any bloom', 'without bloom', 'bloom fully turned off', 'no bloom'],
      apply: function () { return { patch: { 'look.bloom': 0 } }; } },
    { id: 'negative.chroma', group: 'negative', label: '不要色散',
      aliases: ['不要色散', '不需要色散', '禁止色散', 'no chroma',
        'no chromatic aberration'],
      apply: function () { return { patch: { 'look.chroma': 0 } }; } },
    { id: 'negative.vignette', group: 'negative', label: '不要暗角',
      aliases: ['不要暗角', 'no vignette', 'without a vignette'],
      apply: function () { return { patch: { 'look.vignette': 0 } }; } }
  ];

  // 合并顺序（4.3）：同组互斥取文本中最后出现者；跨组同参数后组合法覆盖前组；
  // 否定组最后应用。
  var GROUP_ORDER = ['scene', 'energy', 'camera', 'look', 'hand', 'director', 'negative'];
  var GROUP_TITLES = {
    scene: '场景', energy: '氛围', camera: '镜头', look: '影调',
    hand: '手绘', director: '音乐响应', negative: '否定'
  };

  // -------------------------------------------------------------------------
  // 别名索引：最长优先。开发期重复检查在这里发生（模块加载即抛错）。
  // -------------------------------------------------------------------------

  function buildIndex(rules) {
    var seen = Object.create(null);
    var idx = [];
    rules.forEach(function (rule) {
      if (!rule || typeof rule.id !== 'string' || !Array.isArray(rule.aliases)
          || typeof rule.apply !== 'function') {
        throw new Error('creative-prompt: 规则缺少 id / aliases / apply：'
          + (rule && rule.id));
      }
      rule.aliases.forEach(function (alias) {
        var key = String(alias).toLowerCase();
        if (!key) throw new Error('creative-prompt: 规则 ' + rule.id + ' 有空别名');
        if (seen[key]) {
          throw new Error('creative-prompt: 重复别名 "' + alias + '"（'
            + seen[key] + ' 与 ' + rule.id + '）');
        }
        seen[key] = rule.id;
        idx.push({
          alias: key,
          rule: rule,
          // 纯 ASCII 词组按词边界匹配，避免 "beat" 吃掉 "beats"；
          // 中文按词典短语做子串匹配（词与词之间本就没有边界）。
          ascii: /^[a-z0-9 ]+$/.test(key)
        });
      });
    });
    idx.sort(function (a, b) { return b.alias.length - a.alias.length; });
    return idx;
  }

  function sceneRule(def) {
    return { id: 'scene.' + def.id, group: 'scene', label: def.label,
      aliases: def.aliases.slice(), apply: function () { return { scene: def.id }; } };
  }

  function currentRules() {
    var definitions = window.CreativeGL ? CreativeGL.scenes()
      : window.CreativeStage && CreativeStage.scenes ? CreativeStage.scenes() : [];
    return definitions.filter(function (def) { return Array.isArray(def.aliases); }).map(sceneRule).concat(RULES);
  }

  // 开发期校验内置词典；之后注册的场景也必须在写入登记表之前通过相同校验。
  buildIndex(currentRules());
  if (window.CreativeGL && CreativeGL.reserveAliases) {
    CreativeGL.reserveAliases(RULES.reduce(function (aliases, rule) { return aliases.concat(rule.aliases); }, []));
  }

  function ruleById(id, rules) {
    for (var i = 0; i < rules.length; i += 1) if (rules[i].id === id) return rules[i];
    return null;
  }

  // -------------------------------------------------------------------------
  // 归一化（4.1）
  // -------------------------------------------------------------------------

  // 按 code point 截断。手写而不是用扩展运算符：本模块承诺在缺
  // String.prototype.normalize 的老浏览器上也能原样跑完（只是不做 NFKC）。
  function truncate(text) {
    var out = '';
    var n = 0;
    for (var i = 0; i < text.length && n < MAX_CHARS; i += 1) {
      var u = text.charCodeAt(i);
      var size = (u >= 0xD800 && u <= 0xDBFF && i + 1 < text.length) ? 2 : 1;
      out += text.substr(i, size);
      n += 1;
      i += size - 1;
    }
    return out;
  }

  function normalizeText(text) {
    if (typeof text !== 'string') return '';
    var s = truncate(text);
    if (s.normalize) {
      try { s = s.normalize('NFKC'); } catch (e) { /* 老引擎：原样继续 */ }
    }
    s = s.toLowerCase();
    s = s.replace(/([0-9a-z])\.([0-9a-z])/g, '$1\uE000$2');
    s = s.replace(/(^|[^0-9a-z])-(?=\s*[0-9零〇一二两三四五六七八九])/g, '$1\uE001');
    s = s.replace(KEEP_RE, ' ');
    return s.replace(/\s+/g, ' ').trim().replace(/\uE000/g, '.').replace(/\uE001/g, '-');
  }

  // -------------------------------------------------------------------------
  // 扫描：最长别名优先，命中区间互不重叠，每个区间只归属一个规则。
  // 同一规则命中多次时逐条保留（解释用），合并阶段才去重。
  // -------------------------------------------------------------------------

  function overlaps(claimed, start, end) {
    for (var i = 0; i < claimed.length; i += 1) {
      if (claimed[i][0] < end && start < claimed[i][1]) return true;
    }
    return false;
  }

  function isWordChar(code) {
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95;
  }

  function scan(text, index) {
    var matches = [];
    var claimed = [];
    index.forEach(function (entry) {
      var alias = entry.alias;
      var from = 0;
      while (from <= text.length - alias.length) {
        var at = text.indexOf(alias, from);
        if (at < 0) break;
        var end = at + alias.length;
        var hit = true;
        if (entry.ascii) {
          hit = (at === 0 || !isWordChar(text.charCodeAt(at - 1)))
            && (end >= text.length || !isWordChar(text.charCodeAt(end)));
        }
        if (hit && !overlaps(claimed, at, end)) {
          claimed.push([at, end]);
          matches.push({
            ruleId: entry.rule.id,
            group: entry.rule.group,
            label: entry.rule.label,
            source: text.slice(at, end),
            start: at,
            end: end
          });
        }
        from = at + 1;
      }
    });
    matches.sort(function (a, b) { return a.start - b.start; });
    return { matches: matches, claimed: claimed };
  }

  // 命中区间替换为空格后删掉停用词，剩余连续片段去重（保序）进 unknown。
  function leftovers(text, claimed) {
    var masked = text;
    // 从后往前替换，前面的区间偏移不受影响
    claimed.sort(function (a, b) { return b[0] - a[0]; }).forEach(function (iv) {
      masked = masked.slice(0, iv[0]) + ' ' + masked.slice(iv[1]);
    });
    var out = [];
    masked.split(' ').forEach(function (seg) {
      if (!seg || STOPWORDS[seg]) return;
      if (out.indexOf(seg) < 0) out.push(seg);
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // 合并（4.3）：组间按 GROUP_ORDER，组内互斥取最后出现者并记警告。
  // -------------------------------------------------------------------------

  // 规则输出的"脚印"：它会改写哪些东西。同组两条规则脚印相交才算互斥。
  function footprint(effect) {
    var keys = [];
    if (!effect) return keys;
    if (effect.scene) keys.push('scene');
    if (typeof effect.director === 'boolean') keys.push('director');
    if (effect.hand && typeof effect.hand.on === 'boolean') keys.push('hand.on');
    if (effect.patch) {
      Object.keys(effect.patch).forEach(function (k) { keys.push('p:' + k); });
    }
    return keys;
  }

  function intersects(a, b) {
    for (var i = 0; i < a.length; i += 1) {
      if (b.indexOf(a[i]) >= 0) return true;
    }
    return false;
  }

  function effectValue(effect, key) {
    if (key === 'scene') return effect.scene;
    if (key === 'director') return effect.director;
    if (key === 'hand.on') return effect.hand && effect.hand.on;
    if (key.indexOf('p:') === 0) return effect.patch && effect.patch[key.slice(2)];
    return undefined;
  }

  function contradicts(a, b) {
    var shared = footprint(a).filter(function (key) {
      return footprint(b).indexOf(key) >= 0;
    });
    return shared.some(function (key) {
      return effectValue(a, key) !== effectValue(b, key);
    });
  }

  function requiresJointResolution(text) {
    return /必须同时|同时必须|同时只用|两者都必须|两者必须|不能二选一|不许选择其中一个|不允许(?:选择其中一个|取舍)|simultaneously|concurrently|at the same time|\bmust both\b|\bboth\b.{0,30}\b(?:required|mandatory)\b|\bneither\b.{0,35}\b(?:omitted|dropped|excluded)\b|\bcannot choose (?:one|either)\b|\bcan't choose (?:one|either)\b/i.test(text);
  }

  function stripSafeScopeStatements(text) {
    return String(text || '').toLowerCase()
      .replace(/(?:不需要|无需|不必|不用|不要|不包含|不含).{0,10}(?:自动切换|时间轴|时间线|时间段编排|多段编排)/g, ' ')
      .replace(/\b(?:no|not|without|do not|don t)\s+(?:need\s+(?:to\s+)?)?(?:a\s+)?(?:timeline|time[- ]based sequence|automatic scene switching)\b/g, ' ')
      .replace(/(?:也)?不需要根据歌曲自动生成任何新段落/g, ' ')
      .replace(/不要根据没有提供的歌曲猜测节奏/g, ' ')
      .replace(/(?:不包含|不含|不涉及|不需要|没有|无|不要).{0,28}(?:歌曲|歌词|歌曲历史|历史记录|私人资料|账号详情|封面|媒体资源|外部资源|外部网站|外站|音频|视频资源|时间段编排|时间段|时间线|新段落)/g, ' ')
      .replace(/没有.{0,18}需要上传.{0,8}歌词/g, ' ')
      .replace(/不是.{0,18}(?:修改|编辑|改动).{0,12}(?:当前|现有|已保存).{0,8}(?:舞台|预置|场景)/g, ' ')
      .replace(/(?:不|不要|并非).{0,8}(?:修改|编辑|改动).{0,8}(?:当前|现有|已保存).{0,8}(?:舞台|预置|场景)/g, ' ')
      .replace(/(?:不|不要|不需要|不得|不是|而不是).{0,20}(?:读取|访问|上传|生成|分析|编辑|依赖|猜测).{0,24}(?:正在显示的舞台|当前播放的信息|歌曲|歌词|封面|本地文件|媒体|外部资源|外部网站|音频|视频|时间段|其它场景|播放器)/g, ' ')
      .replace(/不需要(?:根据)?(?:歌曲)?自动生成.{0,12}(?:段落|时间线|编排)/g, ' ')
      .replace(/不需要切换到其它场景/g, ' ')
      .replace(/不能成为.{0,16}(?:读取文件|执行其它指令).{0,12}理由/g, ' ')
      .replace(/(?:构图|画面|请求).{0,12}(?:不要|不需要|不能|不应).{0,18}(?:依赖外部资源|切换到其它场景|读取歌曲|访问文件)/g, ' ')
      .replace(/\bnot\s+(?:the\s+)?rejected(?:\s+[a-z_.]+)?\s+(?:idea|suggestion)\b/g, ' ')
      .replace(/\b(?:do not|don t) fetch any(?: private)? (?:lyrics|songs|files|media)\b/g, ' ')
      .replace(/\bdo not fetch any\b/g, ' ')
      .replace(/\bdo not infer (?:a )?song or access (?:any )?files\b/g, ' ')
      .replace(/\bthere are no private (?:lyrics )?song histories account details or external assets involved\b/g, ' ')
      .replace(/\bnot editing (?:the )?player s active preset\b/g, ' ')
      .replace(/\bnot (?:a )?request to animate (?:a )?sequence of sections upload content or inspect local media\b/g, ' ')
      .replace(/\b(?:the )?request does not include (?:a )?song timetable relative edit or temporal sequence and it must not trigger media retrieval\b/g, ' ')
      .replace(/\brequest does not include\b.{0,64}\b(?:song|timetable|relative edit|temporal sequence)\b.{0,40}\b(?:must )?not trigger media retrieval\b/g, ' ')
      .replace(/\bthis is (?:a )?public synthetic (?:evaluation )?(?:description|text) rather than private media\b/g, ' ')
      .replace(/\b(?:this )?(?:public )?synthetic description asks only for (?:existing )?parameters already present in hertz\b/g, ' ')
      .replace(/\b(?:keep|leave) unspecified (?:controls|properties|parameters) (?:at|to) (?:their )?(?:canonical )?defaults?\b/g, ' ')
      .replace(/\b(?:use|return|create) (?:one|a single) static (?:configuration|preset|intent)\b/g, ' ')
      .replace(/\b(?:the )?(?:visual|picture|composition|forms?)\b.{0,28}\bshould be\b.{0,24}\b(?:readable|legible|gentle|clear|stable|soft)\b/g, ' ')
      .replace(/\b(?:a )?broad composition\b.{0,48}\bshould allow (?:the )?forms? to remain legible without extra effects competing for attention\b/g, ' ')
      .replace(/\b(?:keep|maintain|leave)\b.{0,28}\b(?:picture|composition|forms|space)\b.{0,32}\b(?:readable|legible|gentle|clear|stable|soft)\b/g, ' ')
      .replace(/\bmaintain\b.{0,20}\b(?:readable|legible|clear|open)\s+(?:space|areas?)\b/g, ' ')
      .replace(/(?:这|此|本).{0,8}(?:不是|并非).{0,12}(?:歌词|歌曲分析|歌词分析).{0,18}(?:(?:也)?不是|不需要|无需).{0,20}(?:分析歌曲|读取歌曲信息|上传歌词)/g, ' ')
      .replace(/(?:没有|未明确|未说明).{0,12}(?:视觉)?参数.{0,12}(?:不需要|无需|不用).{0,12}(?:额外)?(?:修改|调整|改动)/g, ' ')
      .replace(/(?:其它|其他|未明确|未说明|未指明).{0,8}(?:参数|属性|控制项).{0,8}(?:保留|使用|回到).{0,8}(?:默认值|默认)/g, ' ')
      .replace(/(?:整个|本|这个|这里|请求).{0,12}(?:只|只有|仅).{0,12}(?:一個|一个|单个).{0,12}(?:静态配置|静态候选|配置|预置)/g, ' ')
      .replace(/(?:这|本).{0,10}(?:只是|用于|属于).{0,16}(?:公开|合成|评测|说明).{0,24}(?:不是要求|不需要新增能力)/g, ' ')
      .replace(/(?:要求|描述).{0,15}(?:只是|仅是).{0,15}(?:审美|说明).{0,15}(?:不是|而不是).{0,15}(?:新增能力|新能力)/g, ' ')
      .replace(/所有细节.{0,12}只是描述审美.{0,12}(?:不是|而不是)要求新增能力/g, ' ')
      .replace(/(?:写得较长|较长的公开说明).{0,20}(?:检查|交代).{0,20}(?:最后的明确要求|需求)/g, ' ')
      .replace(/(?:主观)?构图.{0,16}(?:不要|不应|应该|应当).{0,24}(?:抢夺注意力|压迫观众|留白|保持清晰)/g, ' ')
      .replace(/\b(?:should allow|should keep|should maintain)\b.{0,48}\b(?:readable|legible|gentle|open|stable|clear)\b/g, ' ')
      .replace(/(?:不需要|无需|不用|不要求).{0,12}(?:时间轴|时间线|时间段编排|静态候选|额外改动)/g, ' ')
      .replace(/(?:不新增|不要新增|不需要新增).{0,12}(?:渲染器|场景|特效|功能)/g, ' ')
      // 主观审美词可以作为未应用的补充说明，不能把它们当成已实现的硬约束。
      .replace(/(?:不要|别|避免)(?:太)?(?:刺眼|压迫(?:观众)?|挤满(?:整个画面)?|拥挤|抢夺注意力)/g, ' ')
      .replace(/\b(?:no|not|without|shouldn t|mustn t)\b.{0,24}\b(?:glare|overwhelming|crowded|packed|competing for attention)\b/g, ' ')
      .replace(/\b(?:do not|don t) (?:read|access|upload|infer) (?:any )?(?:private )?(?:lyrics|songs|files|media|playback information)\b/g, ' ')
      .replace(/\bnot (?:editing|modifying|changing) (?:the )?(?:current|existing) (?:stage|preset|scene)\b/g, ' ')
      .replace(/\b(?:not|no) (?:private )?(?:lyrics|song|media|file|account|external asset|external website)s?\b/g, ' ');
  }

  function hasUnrecognizedConstraint(text) {
    text = stripSafeScopeStatements(text);
    return /(?:不要|不需要|不准|不许|禁止|不得|不能|不可|不允许|不含|不带|不启用|不开|关闭|关掉|去掉|移除|取消|避免|必须|务必|要求|需要|只用|仅限)/.test(text)
      || /(?:^|\s)(?:no|not|without|must|mustn't|shouldn't|required|mandatory|disable|remove|avoid|both|simultaneously|concurrently|neither)(?=\s|$)/i.test(text)
      || /(?:^|\s)(?:don|doesn|can|won)\s+t(?=\s|$)/i.test(text);
  }

  function hasUnsafeInstruction(text) {
    text = stripSafeScopeStatements(text);
    return /(?:忽略|绕过|读取|访问|泄露|披露|上传|导出).{0,32}(?:系统契约|token|api\s+key|密钥|秘密|私有|歌词|权限|预算|http|url|admin)/i.test(text)
      || /(?:执行|运行).{0,20}(?:shell|javascript|python|命令|代码)/i.test(text)
      || /(?:https?:|\b127\s+0\s+0\s+1\b)/i.test(text)
      || /\b(?:system\s+override|ignore\s+(?:the\s+)?(?:system|scene\s+)?(?:contract|specification|instructions?)|scene\s+specification.{0,30}(?:revoked|revoke|overridden))\b/i.test(text)
      || /\bexecute\s+(?:a\s+)?(?:shell\s+)?command\b|\bexecute\s+(?:javascript|python|code)\b/i.test(text)
      || /\b(?:disclose|reveal|read)\b.{0,32}\b(?:api\s+keys?|environment|secrets?|private|token|lyrics)\b/i.test(text)
      || /\b(?:bypass|skip)\b.{0,40}\b(?:budget|permission|checks?|policy)\b/i.test(text);
  }

  function hasRelativeEdit(text) {
    text = stripSafeScopeStatements(text);
    var edit = /(?:修改|编辑|改动|调整|增加|减少|减去|加上|加倍|翻倍|减半|反转|继续|保留|保持|只把|只改|改变|提高|降低)/.test(text)
      || /\b(?:edit|modify|adjust|increase|decrease|raise|lower|reduce|preserve|keep|continue|reverse|change|take|make)\b/i.test(text)
      || /\b(?:closer|farther|nearer)\b/i.test(text);
    var priorState = /(?:当前|现有|现在|上次|上一次|以前|此前|之前保存|已保存|已经应用|其余内容|其它内容|其他设置)/.test(text)
      || /\b(?:current|existing|previous|prior|last saved|same preset|already applied|active preset|anything else|everything else|without resetting|preserving everything)\b/i.test(text);
    return edit && priorState;
  }

  function hasUnsupportedTimeline(text) {
    text = stripSafeScopeStatements(text);
    return /[0-9零〇一二两三四五六七八九十百千万]+\s*(?:秒|分钟|小时)后.{0,32}(?:切换|转场|跳转)/.test(text)
      || /(?:创建|生成|制作|安排|编排|需要|必须|要求).{0,30}(?:完整|分段|多段)?(?:时间轴|时间线|时间段编排)|不接受静态候选/i.test(text)
      || /自动从.{0,20}(?:切换|转场|跳转).{0,20}(?:到|至)/.test(text)
      || /\bafter\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds?|minutes?).{0,48}\bswitch(?:es)?\b/i.test(text)
      || /\b(?:create|generate|build|make|plan)\b.{0,48}\b(?:timeline|time[- ]based sequence)\b/i.test(text);
  }

  function hasUnrecognizedNumericSetting(unknown, paths, intent, params) {
    var text = unknown.join(' ').toLowerCase();
    var tokens = text.split(/\s+/);
    var wordNumbers = { zero: 0, one: 1, two: 2, three: 3, four: 4,
      five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    var numbers = tokens.filter(function (token) {
      return /^-?\d+(?:\.\d+)?$/.test(token)
        || Object.prototype.hasOwnProperty.call(wordNumbers, token);
    }).map(function (token) {
      return Object.prototype.hasOwnProperty.call(wordNumbers, token)
        ? wordNumbers[token] : Number(token);
    });
    var numericTokens = tokens.filter(function (token) {
      return /^(?:[零〇一二两三四五六七八九十百千万半]+)$/.test(token);
    });
    var hasNumber = numbers.length > 0 || numericTokens.length > 0
      || /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half)\b/i.test(text);
    if (!hasNumber) return false;
    var parameterFields = (paths || []).map(function (path) {
      return { path: String(path), field: String(path).split('.').pop().toLowerCase() };
    });
    var mentioned = parameterFields.filter(function (entry) {
      return tokens.some(function (token) { return token.split('.').indexOf(entry.field) >= 0; });
    });
    var patch = intent && intent.patch || {};
    if (mentioned.length === 1 && numbers.length === 1 && numericTokens.length <= 1
        && numbers.length === tokens.filter(function (token) {
          return /^[0-9]+$/.test(token) || Object.prototype.hasOwnProperty.call(wordNumbers, token);
        }).length
        && typeof patch[mentioned[0].path] === 'number'
        && patch[mentioned[0].path] === numbers[0]) return false;
    var parameterMention = mentioned.length > 0
      || (params || []).some(function (param) {
        var label = normalizeText(param.label || '');
        return label && text.indexOf(label) >= 0;
      })
      || /\b(?:cam|look|stage|sc)\.[a-z][a-z0-9]*\b/.test(text)
      || /(?:半径|曝光|色散|暗角|漂移|抖动|低频|颗粒|饱和度|视场角|机位距离|整体缩放)/.test(tokens.join(' '));
    var assignmentCue = /(?:exactly|precisely|strictly|set|value|equal|is|to|为|等于|设为|设成|精确|严格|恰好|调整为|改为)/i.test(tokens.join(' '));
    return parameterMention || assignmentCue;
  }

  function hasUnrecognizedSceneRequirement(text, matches) {
    var sceneMatched = matches.some(function (match) { return match.group === 'scene'; });
    return !sceneMatched && (/(?:新建|新场景|新舞台|创建|制作|做一个|打造|创作|生成)/.test(text)
      || /(?:^|\s)(?:create|new|fresh|build|make|generate)(?=\s|$)/i.test(text));
  }

  function hasUnrecognizedRequirement(text, unknown, matches, paths, intent, params) {
    return hasUnrecognizedConstraint(unknown.join(' '))
      || hasUnrecognizedNumericSetting(unknown, paths, intent, params)
      || hasUnrecognizedSceneRequirement(text, matches);
  }

  function merge(matches, paths, scenes, rules, normalizedText, numericAssignments) {
    var warnings = [];
    var ruleIds = [];
    var patch = {};
    var scene = null;
    var director = null;
    var hand = null;
    var unsatisfiable = false;
    var numericApplied = false;

    function applyNumericAssignments() {
      var lastByPath = Object.create(null);
      var countByPath = Object.create(null);
      (numericAssignments || []).forEach(function (assignment) {
        countByPath[assignment.path] = (countByPath[assignment.path] || 0) + 1;
        if (assignment.rejected) return;
        if (!lastByPath[assignment.path] || assignment.start > lastByPath[assignment.path].start) {
          lastByPath[assignment.path] = assignment;
        }
      });
      Object.keys(lastByPath).forEach(function (path) {
        patch[path] = lastByPath[path].value;
        ruleIds.push('parameter.' + path);
        if (countByPath[path] > 1) {
          warnings.push('参数 ' + lastByPath[path].label + ' 有多个数值，采用最后一个未否决值 ' + lastByPath[path].value);
        }
      });
      numericApplied = true;
    }

    function applyEffect(effect) {
      if (!effect) return;
      if (effect.scene) scene = effect.scene;
      if (typeof effect.director === 'boolean') director = effect.director;
      if (effect.hand && typeof effect.hand.on === 'boolean') {
        hand = { on: effect.hand.on };
      }
      if (effect.patch) {
        Object.keys(effect.patch).forEach(function (k) {
          patch[k] = effect.patch[k];
        });
      }
    }

    GROUP_ORDER.forEach(function (group) {
      if (unsatisfiable) return;
      if (group === 'negative' && !numericApplied) applyNumericAssignments();
      var inGroup = matches.filter(function (m) { return m.group === group; });
      if (!inGroup.length) return;

      // 每条规则只取它在文本中最后出现的那次命中
      var lastByRule = {};
      inGroup.forEach(function (m) {
        if (!lastByRule[m.ruleId] || m.start > lastByRule[m.ruleId].start) {
          lastByRule[m.ruleId] = m;
        }
      });
      var entries = Object.keys(lastByRule).map(function (k) { return lastByRule[k]; });
      entries.sort(function (a, b) { return a.start - b.start; });
      entries.forEach(function (m) { m.effect = ruleById(m.ruleId, rules).apply(); });

      if (group !== 'negative' && requiresJointResolution(normalizedText)) {
        for (var left = 0; left < entries.length && !unsatisfiable; left += 1) {
          for (var right = left + 1; right < entries.length; right += 1) {
            if (contradicts(entries[left].effect, entries[right].effect)) {
              unsatisfiable = true;
              break;
            }
          }
        }
        if (unsatisfiable) return;
      }

      if (group === 'negative') {
        // 否定规则各写各的参数，彼此不互斥：逐条生效，压过此前所有组。
        entries.forEach(function (m) {
          ruleIds.push(m.ruleId);
          applyEffect(m.effect);
        });
        return;
      }

      // 同组冲突裁决：两条规则的输出写了同一个东西（scene / director /
      // hand.on / 同一个 patch 键）才是互斥；「高速 + 近景」各写各的参数，
      // 必须共存。从文本最后往前收，与已收规则冲突的记为被覆盖项。
      var kept = [];
      for (var i = entries.length - 1; i >= 0; i -= 1) {
        var m = entries[i];
        var fp = footprint(m.effect);
        var hit = null;
        for (var j = 0; j < kept.length; j += 1) {
          if (intersects(fp, kept[j].fp)) { hit = kept[j]; break; }
        }
        if (hit) {
          warnings.push('「' + m.source + '」与「' + hit.m.source + '」冲突，保留后者');
        } else {
          kept.push({ m: m, fp: fp });
        }
      }
      kept.reverse();        // 恢复文本顺序，ruleIds 与阅读顺序一致
      kept.forEach(function (k) {
        ruleIds.push(k.m.ruleId);
        applyEffect(k.m.effect);
      });
    });

    if (!numericApplied) applyNumericAssignments();

    if (unsatisfiable) {
      return { intent: null, warnings: [], code: 'unsatisfiable_constraints' };
    }

    // 路径合法性以运行时舞台为准：退休路径剔除并警告，而不是写进 intent
    // 等待 applyIntent 拒绝 —— 解释要在应用之前给到用户。
    if (paths) {
      Object.keys(patch).forEach(function (k) {
        if (paths.indexOf(k) < 0) {
          delete patch[k];
          warnings.push('参数 ' + k + ' 已不被当前舞台支持，已跳过');
        }
      });
    }
    if (scene && scenes && scenes.indexOf(scene) < 0) {
      warnings.push('场景 ' + scene + ' 当前不可用，已跳过');
      scene = null;
    }

    var intent = { version: 1, ruleIds: ruleIds };
    if (scene) intent.scene = scene;
    intent.patch = patch;
    if (director !== null) intent.director = director;
    if (hand) intent.hand = hand;
    return { intent: intent, warnings: warnings };
  }

  // -------------------------------------------------------------------------
  // 编译上下文：合法场景与路径每次现读，绝不缓存第二份 schema。
  // -------------------------------------------------------------------------

  function collectSpecPaths(spec) {
    var out = [];
    (spec.base || []).forEach(function (g) {
      (g.items || []).forEach(function (row) { out.push(row[0]); });
      (g.selects || []).forEach(function (row) { out.push(row[0]); });
    });
    (spec.scene || []).forEach(function (row) { out.push(row[0]); });
    return out;
  }

  function collectSpecParams(spec) {
    var out = [];
    function add(row) {
      if (!Array.isArray(row) || row.length < 7 || typeof row[0] !== 'string'
          || !isFinite(row[2]) || !isFinite(row[3])) return;
      out.push({ path: row[0], label: String(row[1] || row[0]), min: Number(row[2]), max: Number(row[3]) });
    }
    (spec.base || []).forEach(function (group) {
      (group.items || []).forEach(add);
      (group.selects || []).forEach(function (row) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[2])) return;
        var values = row[2].map(function (option) { return Number(option[0]); })
          .filter(function (value) { return isFinite(value); });
        if (!values.length) return;
        out.push({ path: row[0], label: String(row[1] || row[0]), min: Math.min.apply(Math, values),
          max: Math.max.apply(Math, values), allowed: values });
      });
    });
    (spec.scene || []).forEach(add);
    return out;
  }

  function resolveContext(context, sceneId) {
    var scenes = null;
    var paths = null;
    var params = null;
    if (context && typeof context === 'object') {
      if (Array.isArray(context.scenes)) scenes = context.scenes.slice();
      if (Array.isArray(context.paths)) paths = context.paths.slice();
      if (Array.isArray(context.params)) params = context.params.slice();
    }
    if (!scenes && window.CreativeStage
        && typeof window.CreativeStage.scenes === 'function') {
      scenes = window.CreativeStage.scenes().map(function (s) { return s.id; });
    }
    if ((!paths || !params) && window.CreativeStage
        && typeof window.CreativeStage.spec === 'function') {
      var specScene = sceneId;
      if (!specScene && typeof window.CreativeStage.scene === 'function') {
        specScene = window.CreativeStage.scene();
      }
      var spec = window.CreativeStage.spec(specScene || null);
      if (!paths) paths = collectSpecPaths(spec);
      if (!params) params = collectSpecParams(spec);
    }
    if (paths && params) {
      params = params.filter(function (param) { return paths.indexOf(param.path) >= 0; });
    }
    return { scenes: scenes, paths: paths, params: params };
  }

  function parseNumericValue(value) {
    var words = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (Object.prototype.hasOwnProperty.call(words, value)) return words[value];
    if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
      var parts = value.split('十');
      var tens = parts[0] ? words[parts[0]] * 10 : 10;
      return tens + (parts[1] ? words[parts[1]] : 0);
    }
    var numeric = Number(value);
    return isFinite(numeric) ? numeric : null;
  }

  function extractNumericAssignments(text, params, paths, claimed) {
    var owners = Object.create(null);
    (params || []).forEach(function (param) {
      if (!param || typeof param.path !== 'string' || !isFinite(param.min) || !isFinite(param.max)) return;
      var aliases = [param.path, param.path.split('.').pop(), param.label];
      ['球', '场景', '舞台', '频谱'].forEach(function (prefix) {
        if (typeof param.label === 'string' && param.label.indexOf(prefix) === 0
            && param.label.length > prefix.length + 1) {
          aliases.push(param.label.slice(prefix.length));
        }
      });
      aliases.forEach(function (raw) {
        var alias = normalizeText(raw);
        if (!alias) return;
        if (!owners[alias]) owners[alias] = { param: param, ambiguous: false };
        else if (owners[alias].param.path !== param.path) owners[alias].ambiguous = true;
      });
    });
    var aliases = Object.keys(owners).filter(function (alias) { return !owners[alias].ambiguous; })
      .map(function (alias) { return { alias: alias, param: owners[alias].param }; })
      .sort(function (a, b) { return b.alias.length - a.alias.length; });
    var found = [];
    var occupied = [];
    var invalid = null;
    var cues = /^(?:\s*(?:to|is|at|exactly|precisely|strictly|set|value|parameter|parameters|equal(?:s)?|should|be|must|degrees?|degree|units?|unit|恰好|精确设为|精确设置为|精确调整为|精确(?:为)?|精准(?:为)?|严格(?:为)?|就是|等于|设为|设成|设置为|调整为|改为|必须为|数值为|值为)(?=\s|[-0-9零〇一二两三四五六七八九十]|$))+/i;
    var number = /^(-?(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|[零〇一二两三四五六七八九十]{1,3}))(?=$|[^a-z0-9_.零〇一二两三四五六七八九十百千万])/i;

    aliases.forEach(function (entry) {
      if (invalid) return;
      var from = 0;
      while (from <= text.length - entry.alias.length) {
        var at = text.indexOf(entry.alias, from);
        if (at < 0) break;
        var end = at + entry.alias.length;
        var ascii = /^[a-z0-9_.]+$/.test(entry.alias);
        var boundary = !ascii || ((at === 0 || !isWordChar(text.charCodeAt(at - 1)))
          && (end >= text.length || !isWordChar(text.charCodeAt(end))));
        var overlapsRule = (claimed || []).some(function (range) { return range[0] < end && at < range[1]; });
        var overlapsAssignment = occupied.some(function (range) { return range[0] < end && at < range[1]; });
        if (boundary && !overlapsRule && !overlapsAssignment) {
          var rest = text.slice(end);
          var cue = cues.exec(rest);
          if (cue) rest = rest.slice(cue[0].length);
          var leading = rest.length - rest.replace(/^\s+/, '').length;
          rest = rest.slice(leading);
          var valueMatch = number.exec(rest);
          if (valueMatch) {
            var value = parseNumericValue(valueMatch[1]);
            var valueEnd = end + (cue ? cue[0].length : 0) + leading + valueMatch[0].length;
            if (value === null || value < Number(entry.param.min) - 1e-9
                || value > Number(entry.param.max) + 1e-9
                || (entry.param.allowed && entry.param.allowed.indexOf(value) < 0)) {
              invalid = { path: entry.param.path, label: entry.param.label,
                min: entry.param.min, max: entry.param.max, allowed: entry.param.allowed,
                value: valueMatch[1] };
              return;
            }
            var rejectionPrefix = /\bnot\s+(?:the\s+)?rejected\s+$/i.exec(text.slice(0, at));
            var rejectionSuffix = /^\s*(?:idea|suggestion)\b/i.exec(text.slice(valueEnd));
            var assignment = { path: entry.param.path, label: entry.param.label, value: value,
              start: at, end: valueEnd,
              claimStart: rejectionPrefix ? at - rejectionPrefix[0].length : at,
              claimEnd: rejectionSuffix ? valueEnd + rejectionSuffix[0].length : valueEnd,
              rejected: !!(rejectionPrefix && rejectionSuffix), source: text.slice(at, valueEnd) };
            found.push(assignment);
            occupied.push([at, valueEnd]);
          }
        }
        from = at + 1;
      }
    });

    found.sort(function (a, b) { return a.start - b.start; });
    return { assignments: found, invalid: invalid };
  }

  // -------------------------------------------------------------------------
  // compile：唯一公开入口。拒绝时绝不产出意图或默认舞台。
  // -------------------------------------------------------------------------

  function compile(text, context) {
    var normalized = normalizeText(text);

    if (!normalized) {
      return { ok: false, code: 'empty', message: '没有可识别的文本',
        normalized: normalized, intent: null, matches: [], unknown: [], warnings: [] };
    }

    var rules = currentRules();
    var found = scan(normalized.replace(/\./g, ' '), buildIndex(rules));
    found.matches.forEach(function (match) {
      match.source = normalized.slice(match.start, match.end);
    });
    if (hasUnsafeInstruction(normalized)) {
      return { ok: false, code: 'unsafe_instruction',
        message: '描述包含越界的数据访问、网络访问或命令执行要求；请只描述舞台场景与视觉参数。当前结果未应用。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }
    if (hasRelativeEdit(normalized)) {
      return { ok: false, code: 'unsupported_edit',
        message: '当前版本只支持从默认值创建新舞台候选，不支持相对修改当前或已保存预置；当前舞台未改动。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }
    if (hasUnsupportedTimeline(normalized)) {
      return { ok: false, code: 'unsupported_timeline',
        message: '当前版本只支持单个静态舞台候选，不支持时间轴或自动切换编排；当前结果未应用。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }

    var targetScene = null;
    found.matches.forEach(function (match) {
      if (match.group === 'scene') targetScene = match.ruleId.slice('scene.'.length);
    });
    var ctx = resolveContext(context, targetScene);
    var parsed = extractNumericAssignments(normalized, ctx.params, ctx.paths, found.claimed);
    if (parsed.invalid) {
      var bad = parsed.invalid;
      var rangeMessage = bad.allowed
        ? '只接受 ' + bad.allowed.join('、')
        : '必须在 ' + bad.min + ' 至 ' + bad.max + ' 之间';
      return { ok: false, code: 'unrecognized_constraints',
        message: '参数 ' + bad.label + ' 的值' + rangeMessage + '；当前结果未应用。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }
    var usableAssignments = Object.create(null);
    parsed.assignments.forEach(function (assignment) {
      if (!assignment.rejected) usableAssignments[assignment.path] = true;
    });
    if (parsed.assignments.some(function (assignment) {
      return assignment.rejected && !usableAssignments[assignment.path];
    })) {
      return { ok: false, code: 'unrecognized_constraints',
        message: '参数值已被明确否决，但没有给出替代值；当前结果未应用。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }
    parsed.assignments.forEach(function (assignment) {
      found.claimed.push([assignment.claimStart, assignment.claimEnd]);
      found.matches.push({ ruleId: 'parameter.' + assignment.path, group: 'parameter',
        label: assignment.label + (assignment.rejected ? '（已否决）' : '') + ' = ' + assignment.value,
        source: assignment.source,
        start: assignment.start, end: assignment.end });
    });
    found.matches.sort(function (a, b) { return a.start - b.start; });
    var unknown = leftovers(normalized, found.claimed);

    if (!found.matches.length) {
      if (parsed.assignments.length || hasUnrecognizedRequirement(normalized, unknown, found.matches, ctx.paths, null, ctx.params)) {
        return { ok: false, code: 'unrecognized_constraints',
          message: '数值参数需要同时指定支持的目标场景；或描述包含未识别的禁止、必要条件和新场景要求。当前结果未应用。',
          normalized: normalized, intent: null, matches: [], unknown: unknown, warnings: [] };
      }
      return { ok: false, code: 'no_match', message: '没有命中任何支持的词',
        normalized: normalized, intent: null, unknown: unknown, warnings: [] };
    }

    // merge 会在 match 上挂内部 effect 字段：传副本进去，公开返回值保持干净
    var merged = merge(found.matches.map(function (m) {
      return { ruleId: m.ruleId, group: m.group, label: m.label,
        source: m.source, start: m.start, end: m.end };
    }), ctx.paths, ctx.scenes, rules, normalized, parsed.assignments);
    if (merged.code === 'unsatisfiable_constraints') {
      return { ok: false, code: merged.code,
        message: '描述要求同时满足互斥条件，无法生成；请明确选择其中一个。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: unknown, warnings: merged.warnings };
    }
    if (hasUnrecognizedRequirement(normalized, unknown, found.matches, ctx.paths, merged.intent, ctx.params)) {
      return { ok: false, code: 'unrecognized_constraints',
        message: '包含未识别的禁止、必要条件或新场景要求，无法安全应用；请改写这些约束。当前结果未应用。',
        normalized: normalized, intent: null, matches: found.matches,
        unknown: unknown, warnings: merged.warnings };
    }
    return {
      ok: true,
      normalized: normalized,
      intent: merged.intent,
      matches: found.matches,
      unknown: unknown,
      warnings: merged.warnings
    };
  }

  // 支持词清单（给工坊展示"只认这些"用）。全部深拷贝，调用方改不动规则表。
  function supported() {
    var groups = [];
    var definitions = currentRules();
    GROUP_ORDER.forEach(function (group) {
      var rules = [];
      definitions.forEach(function (rule) {
        if (rule.group !== group) return;
        rules.push({ id: rule.id, label: rule.label, aliases: rule.aliases.slice() });
      });
      if (rules.length) {
        groups.push({ id: group, title: GROUP_TITLES[group] || group, rules: rules });
      }
    });
    return { version: 1, maxLength: MAX_CHARS, groups: groups };
  }

  window.CreativePrompt = {
    compile: compile,
    supported: supported
  };
})();
