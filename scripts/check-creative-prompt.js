#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 离线提示词编译器的无头契约检查（零依赖）。
//
// creative-prompt.js 是纯函数模块：没有 DOM、存储、网络与定时器。所以这里的
// 沙箱刻意比 check-creative.js 的更穷 —— 连 document 和 localStorage 都不给，
// 模块照常加载并给出确定结果，本身就是"无副作用"这条契约的行为证明。
//
//   node scripts/check-creative-prompt.js
//
// 覆盖：方案第 2 节的 7 个验收输入、英文别名与词边界、NFKC 全角归一、
// 120 字截断（按 code point）、重复别名开发期报错、结果可重复、返回值防污染、
// 默认上下文（从 CreativeStage 现读）、退休路径与不可用场景的警告、否定最后生效。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'crates', 'hertz-studio', 'web');

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}

function section(name) {
  console.log('\n' + name);
}

// ---------------------------------------------------------------------------
// 沙箱：只有 window（指向自身）与语言内建。没有 document / localStorage /
// fetch / 定时器 —— 模块仍须可用。
// ---------------------------------------------------------------------------

const sandbox = {
  console,
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  isFinite
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(path.join(WEB, 'creative-prompt.js'), 'utf8');

section('加载模块（无 DOM / 无存储 / 无网络）');
// 行为证明的一半：沙箱里根本没有那些全局量，能加载、能编译就说明没碰它们。
vm.runInContext(src, sandbox, { filename: 'creative-prompt.js' });
const CP = sandbox.CreativePrompt;
ok(!!CP && typeof CP.compile === 'function', '定义了 window.CreativePrompt.compile');
ok(typeof CP.supported === 'function', '定义了 window.CreativePrompt.supported');

// 行为证明的另一半：源码里不许出现这些依赖的痕迹。
['fetch(', 'XMLHttpRequest', 'localStorage', 'document.', 'setTimeout',
  'setInterval', 'new Image'].forEach((needle) => {
  ok(src.indexOf(needle) < 0, `源码不依赖 ${needle.replace('(', '')}`);
});

// 默认上下文的供体：scenes/spec 的形状与 creative-stage.js 的公开 API 一致。
// 所以后面的验收输入走的是"每次现读舞台 schema"的真实路径，而不是注入表。
sandbox.CreativeStage = {
  scenes: () => [
    { id: 'towers', label: '频谱塔林' },
    { id: 'orb', label: '频谱球' },
    { id: 'tunnel', label: '光隧道' },
    { id: 'nebula', label: '星云' },
    { id: 'terrain', label: '频谱地形' },
    { id: 'lyric', label: '三维歌词' }
  ],
  spec: () => ({
    base: [
      { id: 'cam', items: [
        ['cam.fov', '视场角', 30, 110, 1, '°', 58],
        ['cam.dist', '机位距离', 3, 44, 0.5, '', 15],
        ['cam.drift', '自动漂移', 0, 200, 5, '%', 40],
        ['cam.shake', '节拍抖动', 0, 200, 5, '%', 70],
        ['cam.kick', '低频跟随', 0, 200, 5, '%', 80]
      ] },
      { id: 'look', items: [
        ['look.bloom', '泛光', 0, 3, 0.05, '', 0.9],
        ['look.chroma', '径向色散', 0, 4, 0.05, '', 0.35],
        ['look.vignette', '暗角', 0, 1.2, 0.02, '', 0.28],
        ['look.grain', '胶片颗粒', 0, 1.2, 0.02, '', 0.20],
        ['look.toon', '手绘描边', 0, 1, 0.02, '', 0],
        ['look.paper', '纸张质感', 0, 1, 0.02, '', 0],
        ['look.saturation', '饱和度', 0, 2, 0.02, '', 1.10]
      ], selects: [['look.grade', '调色', [['0', '原色'], ['1', '双色调'], ['2', '单色'], ['3', '霓虹']], 0]] },
      { id: 'stage', items: [
        ['stage.scale', '整体缩放', 0.3, 2.5, 0.05, '', 1]
      ] }
    ],
    scene: []
  })
};

section('方案第 2 节：7 个验收输入');
{
  let r = CP.compile('梦幻星云，缓慢镜头，霓虹，跟随音乐');
  ok(r.ok === true, '例 1 解析成功');
  ok(r.normalized === '梦幻星云 缓慢镜头 霓虹 跟随音乐',
    '例 1 归一化文本（' + r.normalized + '）');
  ok(r.intent.scene === 'nebula', '例 1 场景=nebula');
  ok(r.intent.patch['cam.drift'] === 18 && r.intent.patch['cam.shake'] === 25,
    '例 1 低镜头漂移（motion.slow）');
  ok(r.intent.patch['look.grade'] === 3, '例 1 look.grade=3');
  ok(r.intent.director === true, '例 1 director=true');
  ok(r.unknown.length === 0, '例 1 没有未识别片段');
  ok(JSON.stringify(r.intent.ruleIds) ===
    JSON.stringify(['scene.nebula', 'motion.slow', 'look.neon', 'director.follow']),
    '例 1 ruleIds 顺序（' + JSON.stringify(r.intent.ruleIds) + '）');
  ok(r.matches.filter((m) => m.ruleId === 'scene.nebula').length === 2,
    '例 1 梦幻/星云 两次命中都保留在 matches 里');
  ok(r.warnings.length === 0, '例 1 同规则双命中不算冲突');

  r = CP.compile('高速隧道，强烈节拍，近景，不要颗粒');
  ok(r.ok === true && r.intent.scene === 'tunnel', '例 2 场景=tunnel');
  ok(r.intent.patch['cam.drift'] === 115 && r.intent.patch['cam.shake'] === 130,
    '例 2 高运动（motion.fast 覆盖 energy.pulse 的同参数）');
  ok(r.intent.patch['cam.kick'] === 120, '例 2 低频跟随来自 energy.pulse');
  ok(r.intent.patch['cam.dist'] === 9, '例 2 较近机位');
  ok(r.intent.patch['look.grain'] === 0, '例 2 不要颗粒');
  ok(r.warnings.length === 0, '例 2 高速与近景不互斥，没有冲突警告');

  r = CP.compile('歌词走廊，安静，单色，固定镜头');
  ok(r.ok === true && r.intent.scene === 'lyric', '例 3 场景=lyric');
  ok(r.intent.patch['cam.drift'] === 12 && r.intent.patch['cam.shake'] === 15,
    '例 3 低运动（energy.quiet）');
  ok(r.intent.patch['look.grade'] === 2, '例 3 look.grade=2');
  ok(r.intent.director === false, '例 3 director=false');

  r = CP.compile('手绘地形，远景，不要抖动');
  ok(r.ok === true && r.intent.scene === 'terrain', '例 4 场景=terrain');
  ok(r.intent.hand && r.intent.hand.on === true, '例 4 hand.on=true');
  ok(r.intent.patch['look.toon'] === 0.75 && r.intent.patch['look.paper'] === 0.65,
    '例 4 手绘影调');
  ok(r.intent.patch['cam.dist'] === 24, '例 4 远机位');
  ok(r.intent.patch['cam.shake'] === 0, '例 4 不要抖动压过远景（否定最后生效）');

  r = CP.compile('星云 隧道');
  ok(r.ok === true && r.intent.scene === 'tunnel', '例 5 最后出现的场景生效');
  ok(r.warnings.length === 1 && r.warnings[0].indexOf('星云') >= 0
    && r.warnings[0].indexOf('隧道') >= 0,
    '例 5 返回场景冲突警告（' + r.warnings[0] + '）');

  r = CP.compile('赛博朋克蓝色海底');
  ok(r.ok === false && r.code === 'no_match', '例 6 无支持词 → no_match');
  ok(r.intent === null, '例 6 不产出意图');
  ok(r.unknown.length >= 1 && r.unknown.join('').indexOf('海底') >= 0,
    '例 6 未识别片段进入 unknown（' + JSON.stringify(r.unknown) + '）');

  ['', '，。、！', '   ', null, 42, {}, undefined].forEach((input) => {
    r = CP.compile(input);
    ok(r.ok === false && r.code === 'empty' && r.intent === null,
      '空白/非字符串 → empty（' + JSON.stringify(input) + '）');
  });
}

section('英文别名与词边界');
{
  let r = CP.compile('nebula tunnel slow');
  ok(r.ok === true && r.intent.scene === 'tunnel', '英文场景词 + 最后出现者生效');
  ok(r.intent.patch['cam.drift'] === 18, '英文 slow → motion.slow');
  ok(r.warnings.length === 1, '两个英文场景词给出冲突警告');

  r = CP.compile('no grain film');
  ok(r.intent.patch['look.grain'] === 0, '英文否定 no grain');
  ok(r.intent.patch['look.vignette'] === 0.42, '英文 film → look.film');

  r = CP.compile('beats fast');
  ok(r.matches.every((m) => m.ruleId !== 'energy.pulse'),
    '词边界：beats 不会被 beat 命中');
  ok(r.intent.patch['cam.drift'] === 115, 'fast 正常命中');

  r = CP.compile('hand drawn lyric corridor');
  ok(r.intent.hand && r.intent.hand.on === true, '英文 hand drawn');
  ok(r.intent.scene === 'lyric', '英文 lyric corridor');
}

section('NFKC 与 120 字截断');
{
  let r = CP.compile('ｎｅｂｕｌａ，星云');
  ok(r.ok === true && r.normalized === 'nebula 星云',
    '全角字母与全角逗号经 NFKC 归一（' + r.normalized + '）');
  ok(r.intent.scene === 'nebula', '归一后场景命中');

  const long = '星云' + '梦'.repeat(128);
  r = CP.compile(long);
  ok(r.ok === true && r.intent.scene === 'nebula', '截断不丢弃开头命中的词');
  ok(r.normalized.length <= 120, '归一化文本 ≤ 120 个 UTF-16 单元（'
    + r.normalized.length + '）');
  ok(Array.from(r.normalized).length <= 120, '归一化文本 ≤ 120 个 code point');

  // 代理对按 code point 截断：127 个 BMP + 尾部星体符号不应被腰斩成坏代理
  const astral = '星云' + '梦'.repeat(126) + '𝄞';
  r = CP.compile(astral);
  ok(r.ok === true, '含星体符号的输入不抛异常');
  ok(r.normalized.indexOf('星云') === 0, '星体符号之前的内容完好');
}

section('同组互斥与跨组覆盖');
{
  let r = CP.compile('安静 爆发');
  ok(r.intent.patch['cam.drift'] === 105, '同组（能量）最后出现者胜出');
  ok(r.warnings.length === 1 && r.warnings[0].indexOf('安静') >= 0,
    '被覆盖项进警告（' + r.warnings[0] + '）');

  r = CP.compile('安静 缓慢');
  ok(r.intent.patch['cam.drift'] === 18 && r.intent.patch['cam.shake'] === 25,
    '跨组同参数：后一个分组（镜头）胜出');
  ok(r.warnings.length === 0, '跨组覆盖是既定合并顺序，不算冲突');

  r = CP.compile('不要抖动 高速');
  ok(r.intent.patch['cam.drift'] === 115 && r.intent.patch['cam.shake'] === 0,
    '否定永远最后生效（shake=0 压过 motion.fast 的 130）');

  r = CP.compile('不要抖动 不要颗粒 不要泛光');
  ok(r.intent.patch['cam.shake'] === 0 && r.intent.patch['look.grain'] === 0
    && r.intent.patch['look.bloom'] === 0, '三条否定彼此不互斥，全部生效');

  r = CP.compile('霓虹 胶片');
  ok(r.warnings.length === 1, '同组写同一参数（bloom）互斥（' + r.warnings[0] + '）');
  ok(r.intent.patch['look.grain'] === 0.55 && r.intent.patch['look.bloom'] === 0.75,
    '胜出的胶片规则完整生效');

  r = CP.compile('不要手绘 手绘');
  ok(r.intent.hand.on === true, '手绘组最后出现者胜出');
  ok(r.warnings.length === 1, '手绘冲突有警告');
}

section('运行时上下文：退休路径与不可用场景');
{
  // paths 里故意少了 look.chroma：编译期就应剔除并警告，而不是留给 applyIntent
  let r = CP.compile('爆发', { paths: ['cam.drift', 'cam.shake', 'cam.kick',
    'look.bloom', 'look.saturation', 'stage.scale'], scenes: ['nebula'] });
  ok(r.ok === true, '有退休路径时仍可应用其余项');
  ok(r.intent.patch['look.chroma'] === undefined, '退休路径被剔除');
  ok(r.warnings.some((w) => w.indexOf('look.chroma') >= 0),
    '退休路径返回警告（' + r.warnings.join('；') + '）');

  r = CP.compile('星云', { scenes: ['towers'] });
  ok(r.ok === true && r.intent.scene === undefined, '不可用场景不写入意图');
  ok(r.warnings.some((w) => w.indexOf('nebula') >= 0 || w.indexOf('星云') >= 0),
    '不可用场景返回警告');
}

section('确定性与防污染');
{
  const t = '梦幻星云，缓慢镜头，霓虹，跟随音乐';
  const a = JSON.stringify(CP.compile(t));
  const b = JSON.stringify(CP.compile(t));
  ok(a === b, '相同输入两次编译结果深相等');

  const r1 = CP.compile(t);
  r1.intent.patch['cam.drift'] = 999;
  r1.intent.ruleIds.push('污染');
  r1.matches[0].label = '污染';
  r1.warnings.push('污染');
  r1.unknown.push('污染');
  const r2 = CP.compile(t);
  ok(r2.intent.patch['cam.drift'] === 18, '外部改动结果对象不污染下一次编译');
  ok(r2.intent.ruleIds.length === 4, 'ruleIds 不被污染');
  ok(r2.matches[0].label === '星云', 'matches 不被污染');
  ok(r2.warnings.length === 0 && r2.unknown.length === 0, '警告与未识别不被污染');

  const s1 = CP.supported();
  ok(s1.groups.length === 7, `supported 覆盖 7 个分组（实际 ${s1.groups.length}）`);
  ok(s1.maxLength === 120, 'supported 透露输入上限');
  ok(s1.groups[0].id === 'scene' && s1.groups[0].rules.length === 6,
    '场景组有 6 条规则');
  s1.groups[0].rules[0].aliases.push('污染');
  s1.groups[0].rules.push({ id: '污染' });
  const s2 = CP.supported();
  ok(s2.groups[0].rules[0].aliases.indexOf('污染') < 0
    && s2.groups[0].rules.length === 6, 'supported 返回深拷贝，规则表改不动');

  ok(CP.compile('柱阵').intent.scene === 'towers'
    && CP.compile('星球').intent.scene === 'orb'
    && CP.compile('山脉').intent.scene === 'terrain',
    '别名只应用一次（污染后词典行为不变）');
}

section('重复别名：开发期错误');
{
  // 别名重复检查在模块初始化时发生。往 RULES 头部注入一条抢别名（星云）的
  // 规则，加载必须抛错 —— 宁可开发期炸，也不要运行期含糊。
  const marker = 'var RULES = [';
  ok(src.indexOf(marker) >= 0, '能定位规则表声明');
  const doctored = src.replace(marker, marker
    + `{ id: 'test.dup', group: 'scene', label: '重复', aliases: ['星云'],
        apply: function () { return { scene: 'towers' }; } },`);
  const box = { console, Math, Date, JSON, Object, Array, String, Number,
    Boolean, Error, isFinite };
  box.window = box;
  vm.createContext(box);
  let threw = null;
  try {
    vm.runInContext(doctored, box, { filename: 'creative-prompt.doctored.js' });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, '重复别名让模块初始化失败');
  ok(!!threw && String(threw.message).indexOf('重复别名') >= 0
    && String(threw.message).indexOf('scene.nebula') >= 0,
    '报错指出冲突双方（' + (threw && threw.message) + '）');
}

// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(56));
if (failures) {
  console.error(`creative prompt: ${checks - failures}/${checks} passed，${failures} 项失败`);
  process.exit(1);
}
console.log(`creative prompt: ${checks}/${checks} passed`);
