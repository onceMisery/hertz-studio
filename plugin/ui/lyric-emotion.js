// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// LyricEmotion：情绪 Cue 的契约层（G4 所需的最小完整实现）。
//
// 只做四件事：绑定歌词快照、严格校验 Cue、按行解析出冻结状态、
// 把状态写成 DOM 属性。场的求值不在本文件——它来自 LyricEmotionField，
// DOM 与字形引擎都只消费同一份采样。
//
// 自动分类和授权设置由 app.js 与 sidecar API 提供；本文件只定义契约、
// Cue 校验和播放时的解析，不负责 provider 接入或持久化。
(function (root, factory) {
  var field = root.LyricEmotionField;
  if (!field && typeof require === 'function') {
    try { field = require('./lyric-emotion-field.js'); } catch (err) { field = null; }
  }
  var api = factory(root, field);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricEmotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, F) {
  'use strict';

  var VERSION = 1;
  var MAX_LINES = 2000;
  var MAX_SECTIONS = 256;
  var MAX_BYTES = 256 * 1024;
  var LINE_CONFIDENCE = 0.55;
  var SECTION_CONFIDENCE = 0.5;
  var MIN_INTENSITY = 0.15;

  var PROFILES = Object.create(null);
  var ALIASES = Object.create(null);
  var profileOrder = [];

  var state = {
    lines: null,
    generation: 0,
    hash: null,
    scale: 1,
    curve: 1,
    accentEnabled: false,
    accentWords: [],
    committed: null,
    pending: null,
    revision: 0,
    paletteEnabled: true
  };

  // P0/P2b 的模型 Cue 缓存：50 首与 1 MiB 双限，先到先淘汰。
  // 手动覆盖不在这里——它按 lyricsHash 独立存储，不能被自动 LRU 挤掉。
  var CACHE_MAX_ENTRIES = 50;
  var CACHE_MAX_BYTES = 1024 * 1024;
  var cache = { map: Object.create(null), order: [], bytes: 0 };

  function cacheKey(doc, hash) {
    return [hash || doc.lyricsHash || '', doc.providerId || '', doc.modelId || '',
      doc.promptVersion == null ? '' : doc.promptVersion,
      doc.catalogVersion == null ? '' : doc.catalogVersion].join('|');
  }
  function cacheBytes(text) { return new TextEncoder().encode(text).length; }
  function cacheDrop(key) {
    var row = cache.map[key];
    if (!row) return;
    cache.bytes -= row.bytes;
    delete cache.map[key];
    var i = cache.order.indexOf(key);
    if (i >= 0) cache.order.splice(i, 1);
  }
  function cachePut(doc) {
    var key = cacheKey(doc);
    var text = JSON.stringify(doc);
    var bytes = cacheBytes(text);
    if (bytes > CACHE_MAX_BYTES) return false;
    cacheDrop(key);
    cache.map[key] = { doc: JSON.parse(text), bytes: bytes };
    cache.order.push(key);
    cache.bytes += bytes;
    while (cache.order.length > CACHE_MAX_ENTRIES || cache.bytes > CACHE_MAX_BYTES) {
      cacheDrop(cache.order[0]);
    }
    return true;
  }
  function cacheGet(hash, meta) {
    var key = cacheKey(Object.assign({ lyricsHash: hash }, meta || {}), hash);
    var row = cache.map[key];
    if (!row) return null;
    var i = cache.order.indexOf(key);
    if (i >= 0) { cache.order.splice(i, 1); cache.order.push(key); }
    return JSON.parse(JSON.stringify(row.doc));
  }
  function loadCached(hash, meta) {
    var doc = cacheGet(hash, meta);
    if (!doc) return false;
    setCueDoc(doc);
    return true;
  }
  function cacheStats() {
    return { entries: cache.order.length, bytes: cache.bytes,
      maxEntries: CACHE_MAX_ENTRIES, maxBytes: CACHE_MAX_BYTES };
  }

  function fail(message) { throw new Error(message); }
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isSafeInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && Math.abs(v) <= 9007199254740991; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function keys(v, allowed) {
    if (!isObject(v)) fail('Cue 字段必须是对象');
    Object.keys(v).forEach(function (key) {
      if (allowed.indexOf(key) < 0) fail('未知 Cue 字段：' + key);
    });
  }
  function frozen(v) { return Object.freeze(v); }
  function neutralProfile() { return PROFILES.neutral; }

  // ---- 档案 ----
  function validateProfile(profile) {
    if (!isObject(profile)) fail('情绪档案必须是对象');
    keys(profile, ['id', 'label', 'aliases', 'field', 'palette', 'archetype', 'type', 'decor']);
    if (typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(profile.id)) fail('情绪 ID 非法');
    if (PROFILES[profile.id]) fail('情绪 ID 重复：' + profile.id);
    if (!isObject(profile.field)) fail('情绪档案缺少 field');
    if (profile.decor != null) {
      if (!Array.isArray(profile.decor)) fail('decor 必须是数组');
      profile.decor.forEach(function (decor) {
        keys(decor, ['kind', 'count', 'climaxCount', 'minIntensity']);
        if (['spark', 'tear', 'ember', 'fog'].indexOf(decor.kind) < 0) fail('未知装饰件：' + decor.kind);
        if (!isSafeInt(decor.count) || decor.count < 0 || decor.count > 6) fail('decor.count 必须在 0..6');
        if (decor.climaxCount != null && (!isSafeInt(decor.climaxCount) || decor.climaxCount < 0 || decor.climaxCount > 6)) {
          fail('decor.climaxCount 必须在 0..6');
        }
        if (decor.minIntensity != null && (!isFinite(decor.minIntensity) || decor.minIntensity < 0 || decor.minIntensity > 1)) {
          fail('decor.minIntensity 必须在 0..1');
        }
      });
    }
    if (profile.type != null) {
      if (!isObject(profile.type)) fail('type 必须是对象');
      if (profile.type.weight != null && (!isFinite(profile.type.weight) || profile.type.weight < 100 || profile.type.weight > 900)) {
        fail('type.weight 必须在 100..900');
      }
      if (profile.type.tracking != null && typeof profile.type.tracking !== 'string') fail('type.tracking 必须是字符串');
      if (profile.type.leading != null && (!isFinite(profile.type.leading) || profile.type.leading < 1 || profile.type.leading > 2.5)) {
        fail('type.leading 必须在 1..2.5');
      }
    }
    if (profile.field.basis !== null && (!F || !F.BASIS[profile.field.basis])) {
      fail('未注册的场基函数：' + profile.field.basis);
    }
    if (profile.field.anchor != null && (!isFinite(profile.field.anchor) || profile.field.anchor < 0 || profile.field.anchor > 0.2)) {
      fail('anchor 必须在 0..0.2');
    }
    if (!isObject(profile.palette)) fail('情绪档案缺少 palette');
    ['ink', 'accent', 'accent2'].forEach(function (key) {
      if (typeof profile.palette[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(profile.palette[key])) {
        fail('palette.' + key + ' 必须是 #rrggbb');
      }
    });
    (profile.aliases || []).forEach(function (alias) {
      if (typeof alias !== 'string' || !alias) fail('别名非法');
      if (PROFILES[alias] || ALIASES[alias]) fail('情绪别名重复：' + alias);
      ALIASES[alias] = profile.id;
    });
    PROFILES[profile.id] = frozen(profile);
    profileOrder.push(profile.id);
  }

  function register(profile) {
    validateProfile(profile);
    return PROFILES[profile.id];
  }

  function list() {
    return profileOrder.map(function (id) {
      var p = PROFILES[id];
      return { id: p.id, label: p.label || p.id, aliases: (p.aliases || []).slice(), field: p.field };
    });
  }

  function profileOf(emotion) {
    if (typeof emotion !== 'string') return null;
    var id = PROFILES[emotion] ? emotion : ALIASES[emotion];
    return id ? PROFILES[id] : null;
  }

  [{
    id: 'neutral', label: '中性', aliases: [],
    field: { basis: null, anchor: 0 }, type: null,
    palette: { ink: '#F4F4F5', accent: '#E4E4E7', accent2: '#A1A1AA' }
  }, {
    id: 'joy', label: '雀跃', aliases: ['happy', 'excited'], archetype: 'bounce',
    field: { basis: 'joy', anchor: 0.10 },
    type: { weight: 700, tracking: '0.025em', leading: 1.55 },
    decor: [{ kind: 'spark', count: 3, climaxCount: 6, minIntensity: 0.75 }],
    palette: { ink: '#FFF7D6', accent: '#FFD166', accent2: '#FF8A5B' }
  }, {
    id: 'sorrow', label: '悲伤', aliases: ['sad'], archetype: 'sink',
    field: { basis: 'sorrow', anchor: 0.14 },
    type: { weight: 400, tracking: '0.06em', leading: 1.85 },
    decor: [{ kind: 'tear', count: 2, climaxCount: 3, minIntensity: 0.75 }],
    palette: { ink: '#C9D6E3', accent: '#7FA7D9', accent2: '#8CA0B8' }
  }, {
    id: 'anger', label: '愤怒', aliases: ['angry'], archetype: 'impact',
    field: { basis: 'anger', anchor: 0.08 },
    type: { weight: 700, tracking: '-0.01em', leading: 1.35 },
    decor: [{ kind: 'ember', count: 4, climaxCount: 6, minIntensity: 0.75 }],
    palette: { ink: '#FFE8D6', accent: '#FF5A36', accent2: '#D7261E' }
  }, {
    id: 'anxious', label: '不安', aliases: [], archetype: 'drift',
    field: { basis: 'anxious', anchor: 0.03 },
    type: { weight: 400, tracking: '0.02em', leading: 1.6 },
    palette: { ink: '#E7EDF7', accent: '#9BB7D4', accent2: '#7C93AD' }
  }, {
    id: 'tender', label: '温柔', aliases: [], archetype: 'float',
    field: { basis: 'tender', anchor: 0.05 },
    type: { weight: 400, tracking: '0.03em', leading: 1.7 },
    palette: { ink: '#F5EADF', accent: '#D8B28C', accent2: '#C9A07A' }
  }, {
    // P3：复用 joy 的 (2u-1)^2，只换系数与配色；不需要改求值器。
    id: 'triumph', label: '胜利', aliases: ['victory'], archetype: 'bounce',
    field: { basis: 'joy', anchor: 0.11 },
    type: { weight: 700, tracking: '0.03em', leading: 1.5 },
    decor: [{ kind: 'spark', count: 4, climaxCount: 6, minIntensity: 0.75 }],
    palette: { ink: '#FFF7D6', accent: '#FFD166', accent2: '#FF8A5B' }
  }, {
    // P3：新增 lonely 场基函数，验证「加形状」的成本高于「加档案」。
    id: 'lonely', label: '孤独', aliases: [], archetype: 'sink',
    field: { basis: 'lonely', anchor: 0.13 },
    type: { weight: 400, tracking: '0.05em', leading: 1.8 },
    decor: [{ kind: 'fog', count: 1, climaxCount: 1, minIntensity: 0.75 }],
    palette: { ink: '#C9D6E3', accent: '#7FA7D9', accent2: '#8CA0B8' }
  }].forEach(register);

  // ---- 哈希 ----
  // 与 creative-draft.js 同一算法；DBX/非安全上下文可能没有 SubtleCrypto。
  function sha256(data) {
    var k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var size = Math.ceil((data.length + 9) / 64) * 64, padded = new Uint8Array(size);
    padded.set(data); padded[data.length] = 128;
    var view = new DataView(padded.buffer), bits = data.length * 8;
    view.setUint32(size - 8, Math.floor(bits / 4294967296)); view.setUint32(size - 4, bits >>> 0);
    function rot(v, n) { return (v >>> n) | (v << (32 - n)); }
    var w = new Int32Array(64);
    for (var offset = 0; offset < size; offset += 64) {
      for (var i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        w[i] = (w[i - 16] + (rot(x, 7) ^ rot(x, 18) ^ (x >>> 3)) + w[i - 7] +
          (rot(y, 17) ^ rot(y, 19) ^ (y >>> 10))) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], j = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (j + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
        var t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        j = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, j].forEach(function (v, i) { h[i] = (h[i] + v) | 0; });
    }
    return h.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
  }

  function canonicalLines(lines) {
    return JSON.stringify([VERSION, lines.map(function (line) {
      if (!isObject(line) || !isSafeInt(line.start_ms) || typeof line.text !== 'string') {
        fail('歌词行必须是 {start_ms: 安全整数, text: 字符串}');
      }
      return [line.start_ms, line.text.normalize('NFC')];
    })]);
  }

  async function digest(text) {
    var data = new TextEncoder().encode(text);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      var bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      return Array.from(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    return sha256(data);
  }

  // ---- 绑定与 Cue ----
  function bindLyrics(snapshot) {
    var lines = snapshot && snapshot.lines;
    if (!Array.isArray(lines)) fail('歌词快照缺少 lines');
    var canonical = canonicalLines(lines);
    state.lines = lines.map(function (line) { return { start_ms: line.start_ms, text: line.text }; });
    state.generation += 1;
    state.hash = null;
    state.committed = null;
    state.pending = null;
    state.revision += 1;
    var generation = state.generation;
    return digest(canonical).then(function (hash) {
      // A→B→A 时旧异步结果不能写回新会话。
      if (generation !== state.generation) return { generation: generation, hash: hash, stale: true };
      state.hash = 'sha256:' + hash;
      return { generation: generation, hash: state.hash, stale: false };
    });
  }

  function hashLyrics(lines) {
    return digest(canonicalLines(lines)).then(function (hash) { return 'sha256:' + hash; });
  }

  function validateCueDoc(doc) {
    keys(doc, ['version', 'lyricsHash', 'sections', 'lines', 'source', 'providerId', 'modelId', 'promptVersion', 'catalogVersion']);
    if (doc.version !== VERSION) fail('Cue version 必须为 1');
    if (typeof doc.lyricsHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(doc.lyricsHash)) fail('lyricsHash 非法');
    if (!state.hash) fail('歌词摘要尚未就绪');
    if (doc.lyricsHash !== state.hash) fail('lyricsHash 与当前歌词不一致');
    var lineCount = state.lines.length;
    var byteLength = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (byteLength > MAX_BYTES) fail('Cue 超过 256 KiB');

    var lines = doc.lines == null ? [] : doc.lines;
    var sections = doc.sections == null ? [] : doc.sections;
    if (!Array.isArray(lines) || lines.length > MAX_LINES) fail('lines 非法或超过 2000 条');
    if (!Array.isArray(sections) || sections.length > MAX_SECTIONS) fail('sections 非法或超过 256 条');

    var byIndex = Object.create(null);
    lines.forEach(function (cue) {
      keys(cue, ['index', 'emotion', 'intensity', 'confidence']);
      if (!isSafeInt(cue.index) || cue.index < 0 || cue.index >= lineCount) fail('行号越界：' + cue.index);
      if (byIndex[cue.index]) fail('行号重复：' + cue.index);
      var profile = profileOf(cue.emotion);
      if (!profile) fail('未知情绪：' + cue.emotion);
      if (typeof cue.intensity !== 'number' || !isFinite(cue.intensity) ||
          typeof cue.confidence !== 'number' || !isFinite(cue.confidence)) {
        fail('intensity/confidence 必须是有限数值');
      }
      byIndex[cue.index] = {
        index: cue.index, emotion: profile.id,
        intensity: clamp01(cue.intensity), confidence: clamp01(cue.confidence)
      };
    });

    var normalized = sections.map(function (cue) {
      keys(cue, ['from', 'to', 'emotion', 'intensity', 'confidence']);
      if (!isSafeInt(cue.from) || !isSafeInt(cue.to)) fail('section 区间必须是安全整数');
      if (cue.from < 0 || cue.to >= lineCount || cue.from > cue.to) fail('section 区间非法');
      var profile = profileOf(cue.emotion);
      if (!profile) fail('未知情绪：' + cue.emotion);
      if (typeof cue.intensity !== 'number' || !isFinite(cue.intensity) ||
          typeof cue.confidence !== 'number' || !isFinite(cue.confidence)) {
        fail('intensity/confidence 必须是有限数值');
      }
      return {
        from: cue.from, to: cue.to, emotion: profile.id,
        intensity: clamp01(cue.intensity), confidence: clamp01(cue.confidence)
      };
    }).sort(function (a, b) { return a.from - b.from; });
    for (var i = 1; i < normalized.length; i += 1) {
      if (normalized[i].from <= normalized[i - 1].to) fail('section 区间重叠');
    }

    return {
      lines: byIndex,
      sections: normalized,
      source: typeof doc.source === 'string' ? doc.source : 'fixture'
    };
  }

  function setCueDoc(doc, token) {
    if (token != null && token !== state.generation) fail('generation 已过期');
    state.pending = validateCueDoc(doc);
    cachePut(doc);
    return true;
  }

  function commitAtBoundary(token) {
    if (token != null && token !== state.generation) fail('generation 已过期');
    if (!state.pending) return false;
    state.committed = state.pending;
    state.pending = null;
    state.revision += 1;
    return true;
  }

  // 显式关闭情绪：保留歌词绑定与缓存，只清掉已提交/待提交的 Cue。
  function clearCues() {
    var changed = !!(state.committed || state.pending);
    state.committed = null;
    state.pending = null;
    if (changed) state.revision += 1;
    return changed;
  }

  function sectionAt(index) {
    if (!state.committed) return null;
    var sections = state.committed.sections;
    for (var i = 0; i < sections.length; i += 1) {
      if (index >= sections[i].from && index <= sections[i].to) return sections[i];
    }
    return null;
  }

  function cueAt(index) {
    if (!state.committed) return null;
    var line = state.committed.lines[index];
    if (line && line.confidence >= LINE_CONFIDENCE) return line;
    var section = sectionAt(index);
    if (section && section.confidence >= SECTION_CONFIDENCE) {
      return {
        index: index, emotion: section.emotion,
        intensity: section.intensity * 0.8, confidence: section.confidence,
        fromSection: true
      };
    }
    return null;
  }

  function effectiveIntensity(cue, scale, curve) {
    if (!cue) return 0;
    var userScale = scale == null ? state.scale : scale;
    var base = clamp01(cue.intensity * (0.4 + 0.6 * cue.confidence) * userScale);
    var power = curve == null ? state.curve : curve;
    if (typeof power !== 'number' || !isFinite(power) || power < 0.5 || power > 1.5) power = 1;
    return clamp01(power === 1 ? base : Math.pow(base, power));
  }

  function parseAccentWords(value) {
    var list = Array.isArray(value) ? value : String(value == null ? '' : value)
      .split(/[,，;；\n]+/);
    var seen = Object.create(null);
    return list.map(function (word) {
      return String(word == null ? '' : word).normalize('NFC').trim().toLowerCase();
    }).filter(function (word) {
      if (!word || seen[word]) return false;
      seen[word] = true;
      return true;
    }).slice(0, 64);
  }

  function accentFor(text) {
    if (!state.accentEnabled || !state.accentWords.length) return false;
    var normalized = String(text == null ? '' : text).normalize('NFC').toLowerCase()
      .trim();
    if (!normalized) return false;
    // 词级宿主直接命中；逐字素宿主（中文 classic）只有单字 token，反向包含
    // 让“星光”也能命中“星/光”两个 token。
    return state.accentWords.some(function (word) {
      return normalized.indexOf(word) >= 0 || word.indexOf(normalized) >= 0;
    });
  }

  function accentWeight(base, intensity) {
    var weight = Number(base);
    if (!isFinite(weight)) weight = 700;
    var eI = Number(intensity);
    if (!isFinite(eI)) eI = 1;
    return Math.min(900, Math.round(weight + 80 * clamp01(eI)));
  }

  function neutralState() {
    var profile = neutralProfile();
    return frozen({
      id: profile.id, profile: profile, intensity: 0,
      field: profile.field, type: profile.type || null, palette: profile.palette,
      archetype: profile.archetype || 'drift', decor: profile.decor || [],
      revision: state.revision, confidence: 1, cue: null
    });
  }

  function resolve(index, ctx) {
    var options = ctx || {};
    var cue = isSafeInt(index) ? cueAt(index) : null;
    var eI = effectiveIntensity(cue, options.scale);
    if (eI < MIN_INTENSITY) return neutralState();
    var profile = profileOf(cue.emotion);
    if (!profile) return neutralState();
    return frozen({
      id: profile.id, profile: profile, intensity: eI,
      field: profile.field, type: profile.type || null, palette: profile.palette,
      archetype: profile.archetype || 'drift', decor: profile.decor || [],
      revision: state.revision, confidence: cue.confidence, cue: cue
    });
  }

  function sampleAt(emotionState, u, emPx) {
    if (!F || !emotionState || !emotionState.profile) return { b: 0, w: 0.5, t: 0 };
    return F.evaluate(emotionState.profile, u, emotionState.intensity, emPx, 0, 0);
  }

  var EMOTION_FONTS = {
    joy: '"YouYuan","Yuanti SC","Arial Rounded MT Bold","Microsoft YaHei",sans-serif',
    sorrow: '"FangSong","STFangsong","Noto Serif CJK SC",serif',
    anger: '"Noto Sans CJK SC","Microsoft YaHei","Arial Black",sans-serif',
    anxious: '"JetBrains Mono",Consolas,"Microsoft YaHei",monospace',
    tender: '"KaiTi","STKaiti","Kaiti SC","Noto Serif CJK SC",serif',
    triumph: '"Microsoft YaHei","Noto Sans CJK SC","Arial Black",sans-serif',
    lonely: '"FangSong","STFangsong","Noto Serif CJK SC",serif'
  };

  function fontFamily(emotion, fallback) {
    return emotion && emotion.id !== 'neutral' && emotion.intensity >= MIN_INTENSITY
      ? EMOTION_FONTS[emotion.id] || fallback : fallback;
  }

  function motionPose(emotion, u, time, emPx, emphasis, reduced) {
    var pose = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, skew: 0 };
    if (!emotion || emotion.id === 'neutral' || emotion.intensity < MIN_INTENSITY) return pose;
    var intensity = clamp01(emotion.intensity);
    var size = emPx * intensity;
    var phase = u * Math.PI * 2;
    var clock = time * Math.PI / 3;
    var wave = reduced ? 0 : Math.sin(clock - phase * 0.5);
    var swell = reduced ? 0 : (1 - Math.cos(clock - phase * 0.25)) * 0.5;
    var accent = reduced ? 0 : clamp01(emphasis);
    pose.y = sampleAt(emotion, u, emPx).b;
    switch (emotion.id) {
      case 'joy':
        var bounce = reduced ? 0 : Math.sin(clock * 2 - phase);
        var jump = Math.pow(Math.max(0, bounce), 2);
        var land = Math.pow(Math.max(0, -bounce), 8);
        pose.y -= size * (0.23 * jump + 0.08 * accent);
        pose.rotate = (bounce * 0.06 + accent * 0.025) * intensity;
        pose.scaleX += (0.07 * land - 0.045 * jump) * intensity;
        pose.scaleY += (0.12 * jump - 0.075 * land + 0.04 * accent) * intensity;
        break;
      case 'sorrow':
        pose.y += size * (0.18 * swell + 0.035 * accent);
        pose.rotate = wave * 0.035 * intensity;
        pose.scaleX -= 0.035 * intensity;
        pose.scaleY -= 0.07 * swell * intensity;
        pose.skew = -0.025 * intensity;
        break;
      case 'anger':
        var strike = reduced ? 0 : Math.pow(Math.max(0, Math.sin(clock * 3 - phase * 0.15)), 4);
        var impact = Math.max(strike, accent * 0.8);
        pose.x = size * (reduced ? 0 : Math.sin(clock * 18 + phase) * 0.075 * impact);
        pose.y -= size * 0.09 * impact;
        pose.skew = (-0.09 - 0.035 * impact) * intensity;
        pose.rotate = wave * 0.025 * impact * intensity;
        pose.scaleX += (0.055 + 0.13 * impact) * intensity;
        pose.scaleY += (0.045 + 0.16 * impact) * intensity;
        break;
      case 'anxious':
        var tremble = reduced ? 0 : Math.sin(clock * 7 + phase) * 0.085 + Math.sin(clock * 11 - phase) * 0.035;
        pose.x = size * tremble;
        pose.y += size * (reduced ? 0 : Math.sin(clock * 5 - phase) * 0.065);
        pose.rotate = (0.015 * Math.sin(phase) + tremble * 0.7) * intensity;
        pose.scaleX -= 0.025 * intensity;
        break;
      case 'tender':
        pose.x = size * 0.045 * wave;
        pose.y -= size * (0.10 * wave + 0.035 * accent);
        pose.rotate = (0.018 * Math.sin(phase) + wave * 0.045) * intensity;
        pose.scaleX += (0.035 * swell + 0.02 * accent) * intensity;
        pose.scaleY += (0.035 * swell + 0.02 * accent) * intensity;
        break;
      case 'triumph':
        pose.x = size * (u - 0.5) * 0.12 * swell;
        pose.y -= size * (0.23 * swell + 0.07 * accent);
        pose.scaleX += (0.06 + 0.06 * swell) * intensity;
        pose.scaleY += (0.09 + 0.13 * swell + 0.035 * accent) * intensity;
        break;
      case 'lonely':
        pose.x = size * ((u - 0.5) * (0.16 + 0.28 * swell) + wave * 0.075);
        pose.y += size * (0.065 * wave + 0.08 * swell);
        pose.rotate = wave * 0.035 * intensity;
        pose.scaleX -= (0.045 + 0.025 * swell) * intensity;
        break;
    }
    return pose;
  }

  var GLYPH_EFFECTS = {
    anger: { kind: 'flame', paths: [
      ['M0 6 C-24 4 -21 -19 -12 -30 C-14 -18 -7 -15 -6 -21 C-2 -31 -9 -40 3 -59 C0 -42 20 -33 13 -17 C22 -24 24 -11 17 -1 C13 6 5 8 0 6Z', '#ff5728'],
      ['M0 5 C-12 1 -8 -11 -3 -19 C-4 -8 5 -12 5 -30 C14 -15 12 -1 3 5Z', '#ffd56a']
    ] },
    sorrow: { kind: 'tears', paths: [
      ['M0 -15 C-3 -8 -10 0 -10 6 A10 10 0 0 0 10 6 C10 0 3 -8 0 -15Z', '#58b9ff'],
      ['M-3 -1 C-8 4 -7 10 -3 11 C-5 7 -3 3 -1 1Z', '#d9f3ff']
    ] },
    joy: { kind: 'sparkle', paths: [
      ['M0 -15 L4 -4 L15 0 L4 4 L0 15 L-4 4 L-15 0 L-4 -4Z', '#ffcf63'],
      ['M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2Z', '#fff9d9']
    ] },
    anxious: { kind: 'electric', paths: [
      ['M4 -26 L-11 -4 L0 -4 L-6 24 L14 -6 L4 -6 L11 -26Z', '#b7a1ff'],
      ['M4 -21 L-6 -2 L4 -2 L-1 13 L9 -4 L1 -4Z', '#f0eaff']
    ] },
    tender: { kind: 'petals', paths: [
      ['M0 14 C-21 0 -12 -19 0 -9 C12 -19 21 0 0 14Z', '#f3a9bd'],
      ['M0 9 C-9 -1 -7 -9 -2 -7 C-3 -2 -1 3 0 9Z', '#ffe3e8']
    ] },
    triumph: { kind: 'rays', paths: [
      ['M-3 7 L-5 -23 L0 -40 L5 -23 L3 7Z', '#ffcf54'],
      ['M-1 5 L-2 -22 L0 -32 L2 -22 L1 5Z', '#fff5c4']
    ] },
    lonely: { kind: 'mist', paths: [
      ['M-34 2 C-24 -9 -12 9 0 -2 C12 -14 26 -8 34 2 C23 -3 17 7 5 6 C-11 14 -20 -1 -34 2Z', '#a9c8dc'],
      ['M-24 10 C-10 0 -1 17 15 7 C8 19 -11 9 -24 10Z', '#d8e6ef']
    ] }
  };

  function effectFrame(emotion, index, time, reduced) {
    var def = emotion && emotion.intensity >= MIN_INTENSITY && GLYPH_EFFECTS[emotion.id];
    var result = { kind: def ? def.kind : null, particles: [] };
    if (!def || reduced) return result;
    var intensity = clamp01(emotion.intensity);
    var count = emotion.id === 'sorrow' || emotion.id === 'anxious' || emotion.id === 'lonely' ? 2 : 3;
    for (var i = 0; i < count; i++) {
      var phase = ((time / (emotion.id === 'anger' ? 2 : 3) + index * 0.173 + i / count) % 1 + 1) % 1;
      var wave = Math.sin(phase * Math.PI * 2);
      var fade = Math.pow(Math.sin(phase * Math.PI), 0.7);
      var p = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: intensity };
      if (emotion.id === 'anger') {
        p.x = (i - 1) * 24 + wave * 3; p.y = -17;
        p.scaleX = 0.64 + 0.10 * wave; p.scaleY = (i === 1 ? 1 : 0.73) + 0.16 * wave;
        p.rotation = wave * 0.13; p.alpha *= 0.76 + 0.24 * fade;
      } else if (emotion.id === 'sorrow') {
        p.x = (i ? 1 : -1) * 24 + wave * 3; p.y = 28 + phase * phase * 70;
        p.scaleX = 0.56 + phase * 0.2; p.scaleY = 0.62 + phase * 0.42; p.alpha *= fade;
      } else if (emotion.id === 'joy') {
        p.x = (i - 1) * 32 + wave * 7; p.y = -30 - phase * 38;
        p.scaleX = p.scaleY = 0.42 + 0.38 * fade; p.rotation = phase * 0.9; p.alpha *= fade;
      } else if (emotion.id === 'anxious') {
        p.x = (i ? 1 : -1) * (43 + wave * 3); p.y = wave * 8;
        p.scaleX = 0.65; p.scaleY = 0.6 + 0.2 * fade; p.rotation = wave * 0.18;
        p.alpha *= 0.12 + 0.74 * Math.pow(fade, 3);
      } else if (emotion.id === 'tender') {
        p.x = (i - 1) * 32 + wave * 10; p.y = 16 - phase * 65;
        p.scaleX = p.scaleY = 0.43 + 0.18 * fade; p.rotation = wave * 0.6; p.alpha *= fade * 0.85;
      } else if (emotion.id === 'triumph') {
        p.x = (i - 1) * 28; p.y = -23 - fade * 10;
        p.scaleX = 0.66; p.scaleY = 0.65 + fade * 0.55; p.rotation = (i - 1) * 0.38;
        p.alpha *= 0.35 + fade * 0.6;
      } else {
        p.x = wave * 18; p.y = 6 + i * 18 - phase * 24;
        p.scaleX = 0.8 + phase * 0.5; p.scaleY = 0.7 + phase * 0.3; p.alpha *= fade * 0.45;
      }
      result.particles.push(p);
    }
    return result;
  }

  function effectEnabled(emotion, index, total) {
    return emotion && emotion.intensity >= MIN_INTENSITY && GLYPH_EFFECTS[emotion.id] &&
      index % Math.max(1, Math.ceil(total / 12)) === 0;
  }

  function clearGlyphEffects(el) {
    if (!el._emotionFx) return;
    el._emotionFx.svg.remove();
    delete el._emotionFx;
  }

  function prepareGlyphEffects(el, emotion, index, total) {
    if (!effectEnabled(emotion, index, total)) { clearGlyphEffects(el); return; }
    var def = GLYPH_EFFECTS[emotion.id];
    if (el._emotionFx && el._emotionFx.kind === def.kind) { el._emotionFx.index = index; return; }
    clearGlyphEffects(el);
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'emo-glyph-fx');
    svg.setAttribute('viewBox', '-50 -75 100 150');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('data-emotion-fx', def.kind);
    var groups = effectFrame(emotion, index, 0, false).particles.map(function () {
      var group = document.createElementNS(ns, 'g');
      def.paths.forEach(function (spec) {
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', spec[0]); path.setAttribute('fill', spec[1]); group.appendChild(path);
      });
      svg.appendChild(group); return group;
    });
    el.appendChild(svg);
    el._emotionFx = { svg: svg, kind: def.kind, groups: groups, index: index };
  }

  function paintGlyphEffects(el, emotion, time, reduced) {
    var fx = el._emotionFx;
    if (!fx) return;
    var frame = effectFrame(emotion, fx.index, time, reduced);
    var display = frame.particles.length ? '' : 'none';
    if (fx.svg.style.display !== display) fx.svg.style.display = display;
    frame.particles.forEach(function (p, i) {
      // 量化后不变就不写：逐帧 setAttribute 会和歌词其余部分一样留在失效集里。
      var transform = 'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ') rotate(' +
        (p.rotation * 180 / Math.PI).toFixed(2) + ') scale(' + p.scaleX.toFixed(3) + ' ' + p.scaleY.toFixed(3) + ')';
      var alpha = p.alpha.toFixed(3), cache = fx.groups[i]._emoPainted;
      if (cache === transform + '|' + alpha) return;
      fx.groups[i]._emoPainted = transform + '|' + alpha;
      fx.groups[i].setAttribute('transform', transform);
      fx.groups[i].setAttribute('opacity', alpha);
    });
  }

  function preparePixiGlyphEffects(PIXI, node, emotion, index, total) {
    if (!effectEnabled(emotion, index, total)) return;
    var def = GLYPH_EFFECTS[emotion.id];
    var layer = new PIXI.Container();
    layer.label = 'emotion-fx-' + def.kind;
    layer.eventMode = 'none';
    var source = '<svg xmlns="http://www.w3.org/2000/svg">' + def.paths.map(function (p) {
      return '<path d="' + p[0] + '" fill="' + p[1] + '"/>';
    }).join('') + '</svg>';
    var particles = effectFrame(emotion, index, 0, false).particles.map(function () {
      var graphic = new PIXI.Graphics().svg(source);
      layer.addChild(graphic); return graphic;
    });
    node.parent.addChild(layer);
    node._emotionFx = { layer: layer, particles: particles, index: index, kind: def.kind };
  }

  function paintPixiGlyphEffects(node, emotion, time, reduced) {
    var fx = node._emotionFx;
    if (!fx) return;
    var frame = effectFrame(emotion, fx.index, time, reduced);
    fx.layer.visible = node.visible && frame.particles.length > 0;
    if (!fx.layer.visible) return;
    fx.layer.position.copyFrom(node.position);
    fx.layer.rotation = node.rotation;
    fx.layer.skew.copyFrom(node.skew);
    fx.layer.scale.set(node.scale.x * node.dataset.fontSize / 100, node.scale.y * node.dataset.fontSize / 100);
    fx.layer.alpha = node.alpha;
    frame.particles.forEach(function (p, i) {
      var graphic = fx.particles[i];
      graphic.position.set(p.x, p.y); graphic.scale.set(p.scaleX, p.scaleY);
      graphic.rotation = p.rotation; graphic.alpha = p.alpha;
    });
  }

  // ---- DOM 后端 ----
  var MOTION_VARS = ['--emo-x', '--emo-dy', '--emo-rotate', '--emo-scale-x', '--emo-scale-y'];
  function applyWordMotion(el, emotion, u, time, emPx, emphasis, reduced) {
    var pose = motionPose(emotion, u, time, emPx, emphasis, reduced);
    var values = [pose.x.toFixed(3) + 'px', pose.y.toFixed(3) + 'px', pose.rotate.toFixed(4) + 'rad',
      pose.scaleX.toFixed(4), pose.scaleY.toFixed(4)];
    MOTION_VARS.forEach(function (name, i) {
      if (el.style.getPropertyValue(name) !== values[i]) el.style.setProperty(name, values[i]);
    });
    paintGlyphEffects(el, emotion, time, reduced);
  }
  function setVar(el, name, value) { el.style.setProperty(name, value); }
  function clearVar(el, name) { el.style.removeProperty(name); }
  function rgbText(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
  }

  function clearLine(lineEl, words) {
    if (!lineEl) return;
    lineEl.removeAttribute('data-emotion');
    lineEl.removeAttribute('data-emo-active');
    lineEl.removeAttribute('data-emo-arch');
    lineEl.removeAttribute('data-emo-climax');
    ['--emo-i', '--emo-ink', '--emo-accent', '--emo-accent-2',
      '--emo-ink-rgb', '--emo-accent-rgb',
      '--emo-weight', '--emo-track', '--emo-leading', '--emo-font', '--emo-accent-weight'].forEach(function (name) {
      clearVar(lineEl, name);
    });
    (words || []).forEach(function (word) {
      var el = word && word.el ? word.el : word;
      if (el) {
        MOTION_VARS.forEach(function (name) { clearVar(el, name); });
        clearGlyphEffects(el);
        el.removeAttribute('data-emo-accent');
      }
    });
  }

  // words: [{ el, uStart, uEnd }]（也接受带 data-u-start/data-u-end 的元素）。
  function applyLine(lineEl, words, emotionState, emPx) {
    if (!lineEl) return;
    if (!emotionState || emotionState.id === 'neutral' || emotionState.intensity < MIN_INTENSITY) {
      clearLine(lineEl, words);
      return;
    }
    lineEl.setAttribute('data-emotion', emotionState.id);
    lineEl.setAttribute('data-emo-active', 'true');
    lineEl.setAttribute('data-emo-arch', emotionState.archetype || 'drift');
    if (emotionState.intensity >= 0.75) lineEl.setAttribute('data-emo-climax', 'true');
    else lineEl.removeAttribute('data-emo-climax');
    setVar(lineEl, '--emo-i', emotionState.intensity.toFixed(3));
    setVar(lineEl, '--emo-font', fontFamily(emotionState, 'inherit'));
    if (state.paletteEnabled) {
      setVar(lineEl, '--emo-ink', emotionState.palette.ink);
      setVar(lineEl, '--emo-accent', emotionState.palette.accent);
      setVar(lineEl, '--emo-accent-2', emotionState.palette.accent2);
      setVar(lineEl, '--emo-ink-rgb', rgbText(emotionState.palette.ink));
      setVar(lineEl, '--emo-accent-rgb', rgbText(emotionState.palette.accent));
    } else {
      ['--emo-ink', '--emo-accent', '--emo-accent-2', '--emo-ink-rgb', '--emo-accent-rgb']
        .forEach(function (name) { clearVar(lineEl, name); });
    }
    if (emotionState.type) {
      if (emotionState.type.weight != null) setVar(lineEl, '--emo-weight', String(emotionState.type.weight));
      if (emotionState.type.tracking != null) setVar(lineEl, '--emo-track', emotionState.type.tracking);
      if (emotionState.type.leading != null) setVar(lineEl, '--emo-leading', String(emotionState.type.leading));
    }
    if (state.accentEnabled && state.accentWords.length) {
      setVar(lineEl, '--emo-accent-weight', String(accentWeight(
        emotionState.type && emotionState.type.weight, emotionState.intensity)));
    } else {
      clearVar(lineEl, '--emo-accent-weight');
    }
    (words || []).forEach(function (word, i) {
      var el = word && word.el ? word.el : word;
      if (!el) return;
      var u0 = word && word.uStart != null ? word.uStart : Number(el.getAttribute('data-u-start'));
      var u1 = word && word.uEnd != null ? word.uEnd : Number(el.getAttribute('data-u-end'));
      var u = isFinite(u0) && isFinite(u1) ? (u0 + u1) / 2 : 0.5;
      var b = sampleAt(emotionState, u, emPx).b;
      setVar(el, '--emo-dy', b.toFixed(3) + 'px');
      prepareGlyphEffects(el, emotionState, i, words.length);
      if (emotionState) el.setAttribute('data-emo-i', emotionState.intensity.toFixed(3));
      if (state.accentEnabled && state.accentWords.length && accentFor(el.textContent)) {
        el.setAttribute('data-emo-accent', 'true');
      } else {
        el.removeAttribute('data-emo-accent');
      }
    });
  }

  function bound() { return !!state.lines; }
  function generation() { return state.generation; }
  function lyricsHash() { return state.hash; }
  function revision() { return state.revision; }
  function setScale(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1.5) fail('情绪强度必须在 0..1.5');
    if (state.scale !== v) { state.scale = v; state.revision += 1; }
  }
  function setCurve(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0.5 || v > 1.5) fail('情绪曲线必须在 0.5..1.5');
    if (state.curve !== v) { state.curve = v; state.revision += 1; }
  }
  function setAccent(enabled, words) {
    var nextEnabled = enabled === true;
    var nextWords = parseAccentWords(words);
    var changed = nextEnabled !== state.accentEnabled ||
      nextWords.length !== state.accentWords.length ||
      nextWords.some(function (word, i) { return word !== state.accentWords[i]; });
    state.accentEnabled = nextEnabled;
    state.accentWords = nextWords;
    if (changed) state.revision += 1;
  }
  function setPaletteEnabled(v) {
    var enabled = v !== false;
    if (state.paletteEnabled !== enabled) { state.paletteEnabled = enabled; state.revision += 1; }
  }
  function paletteEnabled() { return state.paletteEnabled; }
  function reset() {
    state.lines = null; state.hash = null; state.generation += 1;
    state.committed = null; state.pending = null; state.revision += 1; state.scale = 1; state.curve = 1;
    state.accentEnabled = false; state.accentWords = [];
    state.paletteEnabled = true;
  }

  return {
    version: VERSION,
    register: register,
    list: list,
    bindLyrics: bindLyrics,
    hashLyrics: hashLyrics,
    setCueDoc: setCueDoc,
    commitAtBoundary: commitAtBoundary,
    clearCues: clearCues,
    loadCached: loadCached,
    cacheGet: cacheGet,
    cacheStats: cacheStats,
    cueAt: cueAt,
    resolve: resolve,
    resolveForLine: resolve,
    effectiveIntensity: effectiveIntensity,
    setCurve: setCurve,
    setAccent: setAccent,
    accentFor: accentFor,
    accentWeight: accentWeight,
    sampleAt: sampleAt,
    fontFamily: fontFamily,
    motionPose: motionPose,
    effectFrame: effectFrame,
    prepareGlyphEffects: prepareGlyphEffects,
    paintGlyphEffects: paintGlyphEffects,
    clearGlyphEffects: clearGlyphEffects,
    preparePixiGlyphEffects: preparePixiGlyphEffects,
    paintPixiGlyphEffects: paintPixiGlyphEffects,
    applyWordMotion: applyWordMotion,
    applyLine: applyLine,
    clearLine: clearLine,
    bound: bound,
    generation: generation,
    lyricsHash: lyricsHash,
    revision: revision,
    setScale: setScale,
    setPaletteEnabled: setPaletteEnabled,
    paletteEnabled: paletteEnabled,
    reset: reset,
    profiles: PROFILES,
    PROFILE_IDS: profileOrder.slice(),
    LINE_CONFIDENCE: LINE_CONFIDENCE,
    SECTION_CONFIDENCE: SECTION_CONFIDENCE,
    MIN_INTENSITY: MIN_INTENSITY
  };
});
