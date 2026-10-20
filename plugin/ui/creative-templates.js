// SPDX-License-Identifier: MIT
// Local, versioned create artifacts. Never re-stamp an old template with a new
// contract: incompatible templates need a deliberate catalog revision.
(function () {
  'use strict';
  var SCHEMA_HASH = 'b21f66f38c39f600319cb68754ab273e52fc454bfbbc080abc2d7eceaa052337';
  var CATALOG = [
    {id:'quiet-orb',version:2,title:'静夜星球',scene:'orb',mood:'克制、留白',motion:'低 · 无节拍抖动',
      boundary:'适合舒缓音乐与大段歌词；球体仍响应实时频谱，不是完全静止的画面。',
      base:'0d84301863cb08d3ce7c54ed8314a56e97eb54288908f31515ac789c8421c790',
      patch:{'cam.dist':15,'cam.drift':4,'cam.shake':0,'cam.kick':0,'look.bloom':.12,
        'look.chroma':0,'look.grain':.04,'look.saturation':.8,'sc.wobble':.08,'sc.amp':.3,'sc.radius':2.8}},
    {id:'neon-towers',version:2,title:'霓虹律动',scene:'towers',mood:'清晰、明亮',motion:'中 · 频谱起伏与缓慢漂移',
      boundary:'适合节奏清晰的音乐；画面随实际频谱变化，低配置设备可能降低分辨率。',
      base:'b41c53f82d41e64f3323bf511b06a45da50c5e778a15db05dd54f0af2dc50c67',
      patch:{'cam.dist':18,'cam.pitch':12,'cam.drift':14,'cam.shake':6,'cam.kick':16,
        'look.bloom':.38,'look.chroma':.1,'look.grain':.04,'look.saturation':1.05,'look.grade':3,
        'sc.height':5,'sc.span':24,'sc.mirror':.12}},
    {id:'ink-terrain',version:2,title:'墨线地形',scene:'terrain',mood:'单色、纸感',motion:'低 · 缓慢地形移动',
      boundary:'适合器乐与低密度歌词；纸感和线条属于后处理，横竖屏构图须分别确认。',
      base:'31e8a2269f8b216ec13197a3994ed30442ead089f7b713f987a7117993608bb9',
      patch:{'cam.dist':17,'cam.height':.8,'cam.pitch':18,'cam.shake':0,'cam.drift':6,'cam.kick':0,
        'look.toon':.5,'look.paper':.25,'look.grain':.08,'look.bloom':.06,'look.chroma':0,
        'look.saturation':.65,'look.grade':2,'sc.amp2':1,'sc.scroll':.08,'sc.wire2':.28}}
  ];
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function entry(id) {
    var item = CATALOG.find(function (t) { return t.id === id; });
    if (!item) throw new Error('未知创作模板');
    return item;
  }
  function info(t) {
    var c = window.CreativeStageContract;
    return {id:t.id,version:t.version,title:t.title,scene:t.scene,mood:t.mood,motion:t.motion,boundary:t.boundary,
      source:'Hertz Studio 内置',reviewStatus:'candidate',schemaVersion:'1',schemaHash:SCHEMA_HASH,basePresetHash:t.base,
      compatible:!!c && c.schemaVersion === '1' && c.schemaHash === SCHEMA_HASH && c.basePresetHashes[t.scene] === t.base};
  }
  async function prepare(id) {
    var t = entry(id), meta = info(t);
    if (!meta.compatible) throw new Error('模板与当前舞台版本不兼容，请更新模板或应用');
    var draft = await CreativeDraft.prepare({artifactVersion:1,mode:'create',schemaVersion:'1',schemaHash:SCHEMA_HASH,
      basePresetHash:t.base,intent:{version:1,scene:t.scene,patch:copy(t.patch),director:false,hand:{on:false}}});
    // A local template also owns its display name. Bind the preview to the full
    // named candidate, and verify it through the same complete preset codec.
    draft.preset.name = t.title;
    draft.preset = CreativeStage.normalizeSharePreset(draft.preset);
    draft.shareCode = await CreativeShareCode.encode(draft.preset,{compress:false});
    var decoded = await CreativeShareCode.decode(draft.shareCode);
    if (CreativeDraft.canonical(decoded) !== CreativeDraft.canonical(draft.preset)) throw new Error('模板分享校验失败');
    draft.proposalHash = await CreativeDraft.hash({templateId:t.id,templateVersion:t.version,
      artifact:draft.artifact,preset:draft.preset});
    draft.template = meta;
    return draft;
  }
  window.CreativeTemplates = {list:function () { return CATALOG.map(info); },prepare:prepare};
})();
