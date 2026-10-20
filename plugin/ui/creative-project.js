// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Editable project envelope. CreativeStage remains the sole preset/render owner.
(function () {
  'use strict';
  var LIMIT = 256 * 1024, verified = null, bindingSerial = 0;
  function fail(message) { throw new Error(message); }
  function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function keys(v, allowed) {
    if (!object(v)) fail('工程字段必须是对象');
    Object.keys(v).forEach(function (k) { if (allowed.indexOf(k) < 0) fail('未知工程字段：' + k); });
  }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function guard(v, depth) {
    if (depth > 12) fail('工程嵌套超过 12 层');
    if (typeof v === 'number' && !Number.isFinite(v)) fail('工程包含非有限数值');
    if (v && typeof v === 'object') Object.keys(v).forEach(function (k) {
      if (['__proto__','prototype','constructor'].indexOf(k) >= 0) fail('工程包含危险字段');
      guard(v[k], depth + 1);
    });
  }
  // JSON.parse accepts duplicate fields. Scan the original valid JSON as well,
  // so an overwritten version, media identity or deeply nested value cannot hide.
  function checkJson(text) {
    var i = 0;
    function space() { while (/\s/.test(text[i] || '') && i < text.length) i++; }
    function string() { var start = i++; while (text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; return JSON.parse(text.slice(start,i)); }
    function value(depth) {
      if (depth > 12) fail('工程嵌套超过 12 层');
      space(); var c = text[i++];
      if (c === '{') {
        var seen = Object.create(null); space(); if (text[i] === '}') { i++; return; }
        while (i < text.length) {
          space(); var k = string();
          if (seen[k]) fail('工程包含重复字段：' + k); seen[k] = true;
          if (['__proto__','prototype','constructor'].indexOf(k) >= 0) fail('工程包含危险字段');
          space(); i++; value(depth+1); space(); if (text[i++] === '}') return;
        }
      } else if (c === '[') {
        space(); if (text[i] === ']') { i++; return; }
        while (i < text.length) { value(depth+1); space(); if (text[i++] === ']') return; }
      } else if (c === '"') { i--; string(); }
      else { while (i < text.length && !/[\s,\]}]/.test(text[i])) i++; }
    }
    value(0);
  }
  function parse(input) {
    var text = typeof input === 'string' ? input : JSON.stringify(input);
    if (!text || new TextEncoder().encode(text).length > LIMIT) fail('工程超过 256 KiB');
    var value = JSON.parse(text); checkJson(text); guard(value,0); return value;
  }
  function media(value) {
    if (value === null) return null;
    keys(value,['kind','sha256','byteLength']);
    if (['local-file-sha256-v1','file-sha256-v1'].indexOf(value.kind) < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.byteLength !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value.byteLength)
      || Number(value.byteLength) > 2147483648) fail('无效的媒体内容身份');
    return {kind:value.kind,sha256:value.sha256,byteLength:value.byteLength};
  }
  function context(value) {
    keys(value,['version','timelineVersion','schemaVersion','schemaHash','media']);
    if (value.version !== 1 || value.timelineVersion !== 1) fail('不支持的工程或时间线版本');
    if (!window.CreativeStageContract || value.schemaVersion !== CreativeStageContract.schemaVersion
      || value.schemaHash !== CreativeStageContract.schemaHash) fail('工程场景契约不兼容');
    return {version:1,timelineVersion:1,schemaVersion:value.schemaVersion,schemaHash:value.schemaHash,media:media(value.media)};
  }
  function makeContext(identity) {
    return context({version:1,timelineVersion:1,schemaVersion:CreativeStageContract.schemaVersion,
      schemaHash:CreativeStageContract.schemaHash,media:identity});
  }
  function validateProjectCues(source, normalized) {
    if (!object(source) || !Array.isArray(source.cues) || source.cues.length !== normalized.cues.length) fail('工程 cue 列表无效');
    var cueFields = ['at','every','len','ease','set'];
    var eases = ['linear','in','out','inout'];
    source.cues.forEach(function (cue, index) {
      keys(cue,cueFields);
      if (Object.prototype.hasOwnProperty.call(cue,'ease') && eases.indexOf(cue.ease) < 0) fail('工程 cue 缓动无效');
      if (Object.prototype.hasOwnProperty.call(cue,'every') && !Number.isInteger(cue.every)) fail('工程 cue 节拍间隔必须为整数');
      var normalizedSet = normalized.cues[index].set;
      Object.keys(cue.set).forEach(function (path) {
        if (!Object.prototype.hasOwnProperty.call(normalizedSet,path)) fail('工程 cue 参数未知：' + path);
        if (cue.set[path] !== normalizedSet[path]) fail('工程 cue 参数超出可用范围：' + path);
      });
    });
  }
  function validateProjectPreset(source, normalized) {
    keys(source,['version','name','scene','director','cam','look','stage','sc','cues','bindings','bg','hand']);
    ['cam','look','stage','sc'].forEach(function (group) {
      keys(source[group],Object.keys(normalized[group]));
      Object.keys(normalized[group]).forEach(function (key) {
        if (source[group][key] !== normalized[group][key]) fail('工程参数超出可用范围：' + group + '.' + key);
      });
    });
    if (!Array.isArray(source.bindings) || source.bindings.length !== normalized.bindings.length) fail('工程绑定列表无效');
    source.bindings.forEach(function (binding) { keys(binding,['target','source','gain']); });
    if (source.bg.type !== 'media') {
      var bgFields = source.bg.type === 'theme' ? ['type'] : ['type','opacity','blur','blend','depthMode'];
      if (source.bg.type === 'mesh' || source.bg.type === 'cover') bgFields.push('hue');
      keys(source.bg,bgFields);
    }
    keys(source.hand,['style','on','frame','wave','annot','paper','jitter','speed']);
    validateProjectCues(source,normalized);
  }
  function prepare(input) {
    var value = parse(input);
    keys(value,['projectVersion','timelineVersion','schemaVersion','schemaHash','preset','media']);
    var meta = context({version:value.projectVersion,timelineVersion:value.timelineVersion,
      schemaVersion:value.schemaVersion,schemaHash:value.schemaHash,media:value.media});
    var preset = CreativeStage.normalizeSharePreset(value.preset);
    validateProjectPreset(value.preset,preset);
    if (preset.cues.some(function (c) { return c.at !== undefined && c.every !== undefined; })) fail('工程 cue 必须明确选择歌曲时间或节拍触发');
    var warnings = [];
    if (value.preset.bg.type === 'media') warnings.push('外部图片/视频不进入工程，已转为主题背景，需另选素材。');
    if (preset.cues.some(function (c) { return c.every !== undefined; })) warnings.push('包含实时节拍 cue；它们依赖音频分析，不属于 seek 可重算的绝对轨。');
    // Reconstruct only the documented fields. URLs, library IDs, thumbnails and
    // arbitrary extra preset data never survive the owner's share-safe validator.
    var project = {projectVersion:1,timelineVersion:1,schemaVersion:meta.schemaVersion,
      schemaHash:meta.schemaHash,preset:preset,media:meta.media};
    var candidate = copy(preset); candidate.project = meta;
    return {project:project,preset:candidate,warnings:warnings};
  }
  function presentation() {
    var p = window.Stage && Stage.presentation ? Stage.presentation() : null;
    if (!p || !p.track || typeof p.track.id !== 'string' || p.mediaTrackId !== p.track.id
      || !Number.isSafeInteger(p.mediaEpoch)) fail('请先选择曲目并等待载入完成');
    return {trackId:p.track.id,epoch:p.mediaEpoch};
  }
  function sameSelection(a,b) { return a.trackId === b.trackId && a.epoch === b.epoch; }
  // Both versioned kinds describe complete file bytes. Legacy local projects
  // remain portable to an identical complete cache or remote representation.
  function sameMedia(a,b) { return !!a && !!b && a.sha256 === b.sha256 && a.byteLength === b.byteLength; }
  async function identify(selection, allowRemoteRead) {
    if (!window.VMusicTransport) fail('媒体读取接口尚未就绪');
    return media(await VMusicTransport.post('/v1/stage/project-media',{
      track_id:selection.trackId,allow_remote_read:allowRemoteRead === true}));
  }
  function unchanged(revision,selection,valid) {
    if (CreativeStage.revision() !== revision || !sameSelection(selection,presentation()) || (valid && !valid())) fail('舞台、曲目或页面已改变，请重新操作');
  }
  async function capture(withMedia, valid, allowRemoteRead) {
    var revision = CreativeStage.revision(), full = CreativeStage.shareSnapshot(), raw = CreativeStage.preset();
    var selection = withMedia ? presentation() : null;
    var identity = selection ? await identify(selection,allowRemoteRead) : null;
    if (selection) unchanged(revision,selection,valid);
    else if (revision !== CreativeStage.revision() || (valid && !valid())) fail('舞台或页面已改变，请重新导出');
    var prepared = prepare({projectVersion:1,timelineVersion:1,schemaVersion:CreativeStageContract.schemaVersion,
      schemaHash:CreativeStageContract.schemaHash,preset:full,media:identity});
    if (raw.bg && raw.bg.type === 'media') prepared.warnings.push('外部图片/视频不进入工程，已转为主题背景，需另选素材。');
    return prepared;
  }
  function apply(prepared, revision) {
    if (revision !== CreativeStage.revision()) fail('舞台已修改，请重新检查工程');
    var safe = prepare(prepared.project);
    verified = null; bindingSerial++;
    CreativeStage.setPreset(safe.preset);
    return safe;
  }
  async function bindCurrent(valid, allowRemoteRead) {
    verified = null;
    CreativeStage.kick();
    var serial = ++bindingSerial, revision = CreativeStage.revision(), current = CreativeStage.preset();
    if (!current.project) fail('请先应用一份工程');
    var meta = context(current.project), selection = presentation(), identity = await identify(selection,allowRemoteRead);
    unchanged(revision,selection,valid);
    if (serial !== bindingSerial) fail('媒体确认已失效，请重试');
    if (meta.media && !sameMedia(meta.media,identity)) fail('当前文件与工程媒体内容不匹配，未绑定');
    verified = {media:identity,selection:selection};
    CreativeStage.setProjectContext(makeContext(identity));
    CreativeStage.kick();
    return identity;
  }
  function timelineAllowed(meta) {
    if (!verified || !meta || !sameMedia(verified.media,meta.media)) return false;
    try { if (sameSelection(verified.selection,presentation())) return true; } catch (_) { /* No selected media. */ }
    verified = null; return false;
  }
  function status() {
    var p = CreativeStage.preset();
    return !p.project ? '当前为普通预置' : timelineAllowed(p.project) ? '本次曲目已确认，工程 cue 轨已启用'
      : p.project.media ? '工程已载入，cue 轨等待媒体内容确认' : '工程未绑定媒体，cue 轨停用';
  }
  document.addEventListener('stage:track-changed',function () {
    verified = null; bindingSerial++;
    if (window.CreativeStage) CreativeStage.kick();
  });
  window.CreativeProject = {prepare:prepare,capture:capture,apply:apply,bindCurrent:bindCurrent,
    normalizeContext:context,timelineAllowed:timelineAllowed,status:status};
})();
