// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 离线提示词编译器：把一句中文/英文描述确定性地编译成 StageIntent。
//
// 这一层只做一件事：文本 → 规则匹配 → 意图。它没有 DOM、没有存储、没有网络、
// 没有随机数 —— 相同的输入和相同的舞台 schema 必须得到深相等的结果。它是
// 「文本编译」的唯一所有者：词典、优先级、否定与组合规则只住在这里，不进
// workshop.js，也不进渲染器。
//
// 它刻意不持有任何舞台 schema。参数路径、范围、场景默认值的唯一权威是
// creative-stage.js：这里每次编译都从 CreativeStage.scenes()/spec() 现读合法
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

  // 输入上限：与工坊输入框的 maxlength=120 同源。截断按 Unicode code point
  // 数（不是 UTF-16 单元），所以emoji、生僻字都算一个字。
  var MAX_CHARS = 120;

  // 命中区间移除后要删掉的停用词：它们是请求的"包装纸"，不是效果。
  var STOPWORDS = {
    '的': 1, '一个': 1, '一种': 1, '和': 1, '与': 1, '还有': 1,
    '请': 1, '要': 1, '想要': 1, '风格': 1, '舞台': 1,
    'the': 1, 'a': 1, 'an': 1, 'and': 1, 'with': 1
  };

  // 归一化白名单：ASCII 字母数字、CJK 统一表意（含扩展 A）之外的字符一律
  // 视为分隔符换成空格。与其枚举中英文标点（永远枚举不全），不如只保留
  // 可能出现在别名里的东西 —— 全角字符先经 NFKC 落回 ASCII，再走到这里。
  var KEEP_RE = /[^0-9A-Za-z_\u3400-\u4DBF\u4E00-\u9FFF]+/g;

  // -------------------------------------------------------------------------
  // 规则表
  //
  // 每条规则 = { id, group, label, aliases, apply }。apply() 返回效果对象
  // { scene? / patch? / director? / hand? }，值都是常量，首期不允许自由数值。
  // 别名在模块初始化时做重复检查：两个规则抢同一个词是词典事故，宁可开发期
  // 抛错，也不要运行期"最后加载的赢了"这种说不清的行为。
  //
  // 场景规则只写 scene，不生成任何 sc.* —— 场景私有默认值是 CreativeStage 的
  // 财产，在这里复制一份就是制造第二份 schema。
  // -------------------------------------------------------------------------

  var RULES = [
    // --- 场景 ---------------------------------------------------------------
    { id: 'scene.towers', group: 'scene', label: '频谱塔林',
      aliases: ['柱阵', '塔林', '频谱塔林', '城市', 'towers'],
      apply: function () { return { scene: 'towers' }; } },
    { id: 'scene.orb', group: 'scene', label: '频谱球',
      aliases: ['星球', '球体', '频谱球', 'orb', 'planet'],
      apply: function () { return { scene: 'orb' }; } },
    { id: 'scene.tunnel', group: 'scene', label: '光隧道',
      aliases: ['隧道', '穿梭', '光隧道', 'tunnel'],
      apply: function () { return { scene: 'tunnel' }; } },
    { id: 'scene.nebula', group: 'scene', label: '星云',
      aliases: ['星云', '梦幻', 'nebula'],
      apply: function () { return { scene: 'nebula' }; } },
    { id: 'scene.terrain', group: 'scene', label: '频谱地形',
      aliases: ['地形', '山脉', '频谱地形', 'terrain'],
      apply: function () { return { scene: 'terrain' }; } },
    { id: 'scene.lyric', group: 'scene', label: '三维歌词',
      aliases: ['歌词走廊', '三维歌词', '文字', 'lyric corridor', 'lyrics'],
      apply: function () { return { scene: 'lyric' }; } },

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
      aliases: ['不要手绘', 'no hand drawn'],
      apply: function () {
        return { hand: { on: false },
          patch: { 'look.toon': 0, 'look.paper': 0 } };
      } },
    { id: 'director.follow', group: 'director', label: '跟随音乐',
      aliases: ['跟随音乐', '跟着音乐', '自动导演', 'follow music', 'auto director'],
      apply: function () { return { director: true }; } },
    { id: 'director.fixed', group: 'director', label: '固定镜头',
      aliases: ['固定镜头', '手动', 'fixed camera', 'manual'],
      apply: function () { return { director: false }; } },

    // --- 否定覆盖：最后合并，永远压过前面各组写下的同参数值 --------------------
    { id: 'negative.shake', group: 'negative', label: '不要抖动',
      aliases: ['不要抖动', 'no shake'],
      apply: function () { return { patch: { 'cam.shake': 0 } }; } },
    { id: 'negative.grain', group: 'negative', label: '不要颗粒',
      aliases: ['不要颗粒', '不要噪点', 'no grain'],
      apply: function () { return { patch: { 'look.grain': 0 } }; } },
    { id: 'negative.bloom', group: 'negative', label: '不要泛光',
      aliases: ['不要泛光', '不要光晕', 'no bloom'],
      apply: function () { return { patch: { 'look.bloom': 0 } }; } }
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
    var seen = {};
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

  var ALIAS_INDEX = buildIndex(RULES);

  function ruleById(id) {
    for (var i = 0; i < RULES.length; i += 1) if (RULES[i].id === id) return RULES[i];
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
    s = s.replace(KEEP_RE, ' ');
    return s.replace(/\s+/g, ' ').trim();
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

  function scan(text) {
    var matches = [];
    var claimed = [];
    ALIAS_INDEX.forEach(function (entry) {
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

  function merge(matches, paths, scenes) {
    var warnings = [];
    var ruleIds = [];
    var patch = {};
    var scene = null;
    var director = null;
    var hand = null;

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
      entries.forEach(function (m) { m.effect = ruleById(m.ruleId).apply(); });

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
    if (Object.keys(patch).length) intent.patch = patch;
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

  function resolveContext(context) {
    var scenes = null;
    var paths = null;
    if (context && typeof context === 'object') {
      if (Array.isArray(context.scenes)) scenes = context.scenes.slice();
      if (Array.isArray(context.paths)) paths = context.paths.slice();
    }
    if (!scenes && window.CreativeStage
        && typeof window.CreativeStage.scenes === 'function') {
      scenes = window.CreativeStage.scenes().map(function (s) { return s.id; });
    }
    if (!paths && window.CreativeStage
        && typeof window.CreativeStage.spec === 'function') {
      paths = collectSpecPaths(window.CreativeStage.spec());
    }
    return { scenes: scenes, paths: paths };
  }

  // -------------------------------------------------------------------------
  // compile：唯一公开入口。失败只有 empty / no_match 两类，绝不抛异常，
  // 绝不产出默认舞台。
  // -------------------------------------------------------------------------

  function compile(text, context) {
    var ctx = resolveContext(context);
    var normalized = normalizeText(text);

    if (!normalized) {
      return { ok: false, code: 'empty', message: '没有可识别的文本',
        normalized: normalized, intent: null, matches: [], unknown: [], warnings: [] };
    }

    var found = scan(normalized);
    if (!found.matches.length) {
      return { ok: false, code: 'no_match', message: '没有命中任何支持的词',
        normalized: normalized, intent: null,
        unknown: leftovers(normalized, found.claimed), warnings: [] };
    }

    // merge 会在 match 上挂内部 effect 字段：传副本进去，公开返回值保持干净
    var merged = merge(found.matches.map(function (m) {
      return { ruleId: m.ruleId, group: m.group, label: m.label,
        source: m.source, start: m.start, end: m.end };
    }), ctx.paths, ctx.scenes);
    return {
      ok: true,
      normalized: normalized,
      intent: merged.intent,
      matches: found.matches,
      unknown: leftovers(normalized, found.claimed),
      warnings: merged.warnings
    };
  }

  // 支持词清单（给工坊展示"只认这些"用）。全部深拷贝，调用方改不动规则表。
  function supported() {
    var groups = [];
    GROUP_ORDER.forEach(function (group) {
      var rules = [];
      RULES.forEach(function (rule) {
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
