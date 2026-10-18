// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

// Bounded StageIntent artifacts. This module validates and materializes only;
// CreativeStage remains the sole owner of presentation and committed state.
(function () {
  'use strict';
  var LIMIT = 16384;
  var TOP = ['version', 'scene', 'patch', 'director', 'hand', 'ruleIds'];
  var ENVELOPE = ['artifactVersion', 'mode', 'intent', 'schemaVersion', 'schemaHash', 'basePresetHash'];
  function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function fail(message) { throw new Error(message); }
  function keys(v, allowed) {
    if (!object(v)) fail('草稿字段必须是对象');
    Object.keys(v).forEach(function (key) { if (allowed.indexOf(key) < 0) fail('未知草稿字段：' + key); });
  }
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (object(v)) return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
    return JSON.stringify(v);
  }
  // Opaque DBX frames can lack SubtleCrypto. The deterministic fallback keeps
  // offline artifact identity available without a host RPC or another runtime.
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
        var x = w[i-15], y = w[i-2];
        w[i] = (w[i-16] + (rot(x,7)^rot(x,18)^(x>>>3)) + w[i-7] + (rot(y,17)^rot(y,19)^(y>>>10))) | 0;
      }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
      for (i = 0; i < 64; i++) {
        var t1=(j+(rot(e,6)^rot(e,11)^rot(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0;
        var t2=((rot(a,2)^rot(a,13)^rot(a,22))+((a&b)^(a&c)^(b&c)))|0;
        j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,j].forEach(function (v,i) { h[i]=(h[i]+v)|0; });
    }
    return h.map(function (v) { return ('00000000'+(v>>>0).toString(16)).slice(-8); }).join('');
  }
  async function hash(v) {
    var data = new TextEncoder().encode(canonical(v));
    if (typeof crypto === 'undefined' || !crypto.subtle) return sha256(data);
    var bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return Array.from(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function guard(value, depth) {
    if (depth > 8) fail('草稿嵌套超过 8 层');
    if (typeof value === 'number' && !Number.isFinite(value)) fail('草稿包含非有限数值');
    if (value && typeof value === 'object') Object.keys(value).forEach(function (key) {
      if (['__proto__', 'prototype', 'constructor'].indexOf(key) >= 0) fail('草稿包含危险字段');
      guard(value[key], depth + 1);
    });
  }
  function bounded(value) {
    var text = JSON.stringify(value);
    if (!text || new TextEncoder().encode(text).length > LIMIT) fail('草稿超过 16 KiB');
    guard(value, 0);
  }
  function commonParams() {
    var rows = [];
    CreativeStage.baseSpec().forEach(function (g) {
      (g.items || []).concat(g.selects || []).forEach(function (r) {
        rows.push({ name: r[0], min: typeof r[2] === 'number' ? r[2] : 0,
          max: typeof r[2] === 'number' ? r[3] : r[2].length - 1,
          default: typeof r[2] === 'number' ? r[6] : r[3] });
      });
    });
    return rows;
  }
  function schema(scenes, common) {
    return { type: 'object', additionalProperties: false,
      required: ['version', 'scene', 'patch'], properties: {
        version: { const: 1 }, scene: { type: 'string', enum: scenes.map(function (s) { return s.id; }) },
        patch: { type: 'object' }, director: { type: 'boolean' },
        hand: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' } } },
        ruleIds: { type: 'array', items: { type: 'string' } },
      }, allOf: scenes.map(function (s) {
        var properties = {};
        common.concat(s.params.map(function (p) { return { name: 'sc.' + p.name }; })).forEach(function (p) {
          properties[p.name] = { type: 'number' };
        });
        return { if: { properties: { scene: { const: s.id } } },
          then: { properties: { patch: { type: 'object', properties: properties, additionalProperties: false } } } };
      }) };
  }
  function manifest() {
    if (!window.CreativeStageContract) fail('舞台草稿契约尚未加载');
    return window.CreativeStageContract;
  }
  function validateIntent(intent) {
    bounded(intent); keys(intent, TOP);
    if (intent.version !== 1) fail('不支持的意图版本');
    var contract = manifest();
    var scene = contract.scenes.find(function (s) { return s.id === intent.scene; });
    if (!scene) fail('未知场景');
    if (!object(intent.patch)) fail('patch 必须是对象');
    Object.keys(intent.patch).forEach(function (key) {
      var known = contract.commonParams.some(function (p) { return p.name === key; })
        || scene.params.some(function (p) { return 'sc.' + p.name === key; });
      if (!known) fail('场景不接受该参数：' + key);
      if (typeof intent.patch[key] !== 'number' || !Number.isFinite(intent.patch[key])) fail('参数必须是有限数值：' + key);
    });
    if ('director' in intent && typeof intent.director !== 'boolean') fail('director 必须是布尔值');
    if ('hand' in intent) { keys(intent.hand, ['on']); if (typeof intent.hand.on !== 'boolean') fail('hand.on 必须是布尔值'); }
    if ('ruleIds' in intent && (!Array.isArray(intent.ruleIds) || !intent.ruleIds.every(function (id) { return typeof id === 'string'; }))) fail('ruleIds 必须是字符串数组');
    return intent;
  }
  function artifact(intent) {
    validateIntent(intent);
    var c = manifest();
    return { artifactVersion: 1, mode: 'create', intent: JSON.parse(JSON.stringify(intent)),
      schemaVersion: c.schemaVersion, schemaHash: c.schemaHash, basePresetHash: c.basePresetHashes[intent.scene] };
  }
  async function prepare(input) {
    if (typeof input === 'string') {
      if (new TextEncoder().encode(input).length > LIMIT) fail('草稿超过 16 KiB');
      input = JSON.parse(input);
    }
    bounded(input); keys(input, ENVELOPE);
    // Snapshot before awaits so caller mutations cannot change what was validated.
    var value = JSON.parse(JSON.stringify(input)), c = manifest();
    if (value.artifactVersion !== 1 || value.mode !== 'create') fail('不支持的草稿版本或模式');
    validateIntent(value.intent);
    if (value.schemaVersion !== c.schemaVersion || value.schemaHash !== c.schemaHash
      || value.basePresetHash !== c.basePresetHashes[value.intent.scene]) fail('草稿与当前舞台版本不兼容，请重新生成');
    if (await hash(CreativeStage.canonicalBaseline(value.intent.scene)) !== value.basePresetHash
      || await hash(c.intentSchema) !== value.schemaHash) fail('当前舞台资源与契约不一致，请刷新或更新应用');
    var out = CreativeStage.materializeIntent(null, value.intent);
    if (!out.ok || out.ignored.length) fail(out.message || '草稿存在未消费参数');
    var preset = CreativeStage.normalizeSharePreset(out.preset);
    var shareCode = await CreativeShareCode.encode(preset, { compress: false });
    var decoded = await CreativeShareCode.decode(shareCode);
    if (canonical(decoded) !== canonical(preset)) fail('草稿分享校验失败');
    var diagnostics = Object.keys(value.intent.patch).map(function (key) {
      var parts = key.split('.'), normalized = preset[parts[0]][parts[1]], requested = value.intent.patch[key];
      return { path: key, requested: requested, normalized: normalized, clamped: requested !== normalized };
    });
    return { artifact: value, preset: preset, shareCode: shareCode, diagnostics: diagnostics,
      proposalHash: await hash(value), persisted: false, applied: false };
  }
  window.CreativeDraft = { prepare: prepare, artifact: artifact, validateIntent: validateIntent,
    canonical: canonical, hash: hash, commonParams: commonParams, schema: schema };
})();
