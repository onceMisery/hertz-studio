// SPDX-License-Identifier: MIT
// Manual sections compile once to the existing absolute cue track. No new clock.
(function () {
  'use strict';
  var MODES = [['quiet','平静'],['verse','叙述'],['chorus','增强'],['original','原始参数']];
  function fail(message) { throw new Error(message); }
  function normalize(sections) {
    if (!Array.isArray(sections) || !sections.length || sections.length > 32) fail('请填写 1–32 个分段');
    var out = sections.map(function (s, i) {
      if (!s || typeof s !== 'object' || Array.isArray(s)
        || Object.keys(s).some(function (k) { return ['at','mode','fade'].indexOf(k) < 0; })) fail('分段字段无效');
      if (!Number.isFinite(s.at) || s.at < 0 || s.at > 86400
        || !Number.isFinite(s.fade) || s.fade < 16 || s.fade > 600000
        || !MODES.some(function (m) { return m[0] === s.mode; })) fail('分段时间、过渡时长或规则无效');
      if (i === 0 && s.at !== 0) fail('首个分段必须从歌曲 0 秒开始');
      return {at:s.at,mode:s.mode,fade:s.fade};
    });
    out.forEach(function (s,i) {
      var next = out[i+1];
      if (next && (next.at <= s.at || (next.at-s.at)*1000 + 1e-7 < s.fade)) {
        fail('分段时间须递增，过渡不能越过下一分段');
      }
    });
    return out;
  }
  function prepare(sections) {
    var normalized = normalize(sections), CS = CreativeStage, revision = CS.revision();
    var source = CS.preset(), preset = CS.shareSnapshot(), rules = CS.sectionRules();
    var paths = Object.keys(rules.verse);
    preset.cues = normalized.map(function (section) {
      var set = {};
      paths.forEach(function (path) {
        var parts = path.split('.');
        set[path] = section.mode === 'original' ? preset[parts[0]][parts[1]] : rules[section.mode][path];
      });
      return {at:section.at,len:section.fade,ease:'inout',set:set};
    });
    // Absolute authored cues must not compete with the automatic director.
    preset.director = false;
    var prepared = CreativeProject.prepare({projectVersion:1,timelineVersion:1,
      schemaVersion:CreativeStageContract.schemaVersion,schemaHash:CreativeStageContract.schemaHash,
      preset:preset,media:source.project ? source.project.media : null});
    if (source.bg && source.bg.type === 'media') prepared.warnings.push('外部图片/视频不进入工程，需另选素材。');
    return {prepared:prepared,revision:revision,sections:normalized,replacedCueCount:source.cues.length,
      directorWasOn:source.director,bindingCount:preset.bindings.length};
  }
  window.CreativeArrangement = {
    modes:function () { return MODES.map(function (m) { return m.slice(); }); },
    prepare:prepare,
    apply:function (plan) { return CreativeProject.apply(plan.prepared,plan.revision); }
  };
})();
