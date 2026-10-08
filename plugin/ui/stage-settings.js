// SPDX-License-Identifier: MIT
// 舞台设置能力：只从宿主状态派生，不保存另一份用户偏好。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StageSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 与 VCP 的模式配置、Folia 的 visualizer registry 一样，由模式能力决定可编辑项。
  function resolve(state) {
    var visual = state.visual || 'stage';
    var effective = state.effective || visual;
    var visuals = state.visuals || [];
    function definition(id) {
      return visuals.find(function (item) { return item.id === id; }) || { id: id, label: id };
    }
    var selected = definition(visual);
    var stanza = visual !== 'stage';
    var creative = state.source === 'creative';
    var covered = creative || stanza && state.background !== 'stage';
    var scene = !!state.webgl && !covered;
    var lyrics = state.lyrics !== false;
    var animated = !state.reduced;
    var rows = {};
    function row(id, enabled, reason) { rows[id] = { enabled: !!enabled, reason: enabled ? '' : reason }; }
    row('s3d-fl-bg-mode', !creative, '当前背景由创意工坊编排；切回沉浸声场后使用此设置');
    row('s3d-layout', !stanza, '当前歌词视觉使用独立排版；切回舞台 3D 歌词轨后生效');
    row('s3d-bloom', scene, creative ? '请在创意工坊的参数中调整场景泛光' : covered ? '当前背景覆盖了 3D 场景；选择「舞台场景（3D）」后生效' : '当前设备未启用 3D 渲染');
    row('s3d-motion', animated && (scene || stanza && lyrics), state.reduced ? '减少动态效果已开启' : '显示歌词或启用 3D 场景后生效');
    row('s3d-reactivity', animated && (scene || stanza && lyrics), state.reduced ? '减少动态效果已开启' : '显示歌词或启用 3D 场景后生效');
    row('s3d-fl-size', lyrics, '显示歌词后生效');
    row('s3d-fl-subtitle', lyrics, '显示歌词后生效');
    row('s3d-fl-opacity', state.background === 'fluid', '仅用于「流体」封面背景');
    row('s3d-fl-phrase', lyrics && state.lyricLayout === 'phrases', lyrics ? '仅用于「词组断行」排布' : '显示歌词后生效');
    ['s3d-fl-accents', 's3d-fl-atmosphere', 's3d-fl-halation'].forEach(function (id) {
      row(id, lyrics && state.background !== 'anime', lyrics ? '商籁壁纸背景使用透明排版，不叠加此效果' : '显示歌词后生效');
    });
    return { visual: visual, effective: effective, stanza: stanza, covered: covered,
      scene: scene, lyrics: lyrics, rows: rows,
      label: selected.kind === 'director' ? selected.label + ' · 当前演出：' + definition(effective).label : selected.label,
      backgroundNote: creative ? '创意编排正在大舞台演出；场景、背景与音乐响应在创意工坊中调整。' : covered ? '当前使用独立背景，已隐藏 3D 场景；原场景设置已保留。' :
        scene ? '3D 背景与歌词同时生效。' : '当前设备未启用 3D 渲染。' };
  }
  return { resolve: resolve };
});
