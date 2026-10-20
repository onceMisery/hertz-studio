#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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

const WEB = path.join(__dirname, '..', 'plugin', 'ui');

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
const definitions = fs.readFileSync(path.join(WEB, 'creative-gl.js'), 'utf8');
vm.runInContext(definitions, sandbox, { filename: 'creative-gl.js' });

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
let activePromptScene = null;
sandbox.CreativeStage = {
  scene: () => activePromptScene,
  scenes: () => [
    { id: 'towers', label: '频谱塔林' },
    { id: 'orb', label: '频谱球' },
    { id: 'tunnel', label: '光隧道' },
    { id: 'nebula', label: '星云' },
    { id: 'terrain', label: '频谱地形' },
    { id: 'lyric', label: '三维歌词' }
  ],
  spec: (sceneId) => ({
    base: [
      { id: 'cam', items: [
        ['cam.fov', '视场角', 30, 110, 1, '°', 58],
        ['cam.dist', '机位距离', 3, 44, 0.5, '', 15],
        ['cam.drift', '自动漂移', 0, 200, 5, '%', 40],
        ['cam.shake', '节拍抖动', 0, 200, 5, '%', 70],
        ['cam.kick', '低频跟随', 0, 200, 5, '%', 80],
        ['cam.yaw', '水平角度', -180, 180, 1, '°', 0]
      ] },
      { id: 'look', items: [
        ['look.bloom', '泛光', 0, 3, 0.05, '', 0.9],
        ['look.chroma', '径向色散', 0, 4, 0.05, '', 0.35],
        ['look.exposure', '曝光', 0.4, 2.4, 0.02, '', 1],
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
    scene: sceneId === 'orb' ? [['sc.radius', '半径', 1, 8, 0.1, '', 3]]
      : sceneId === 'tunnel' ? [['sc.push', '推进', 0, 4, 0.1, '', 1]] : []
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

  r = CP.compile('同一个新舞台必须同时只用 orb 和只用 towers，不能二选一。');
  ok(r.ok === false && r.code === 'unsatisfiable_constraints' && r.intent === null,
    '明确要求同时使用互斥场景时拒绝生成');
  ok(r.message.indexOf('请明确选择') >= 0, '不可满足的场景冲突说明需要用户明确选择');

  r = CP.compile('New orb and towers are both required at the same time');
  ok(r.ok === false && r.code === 'unsatisfiable_constraints',
    '英文明确同时要求互斥场景时拒绝生成');

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

section('NFKC 与输入长度边界');
{
  let r = CP.compile('ｎｅｂｕｌａ，星云');
  ok(r.ok === true && r.normalized === 'nebula 星云',
    '全角字母与全角逗号经 NFKC 归一（' + r.normalized + '）');
  ok(r.intent.scene === 'nebula', '归一后场景命中');

  const long = '星云' + '梦'.repeat(520);
  r = CP.compile(long);
  ok(r.ok === true && r.intent.scene === 'nebula', '截断不丢弃开头命中的词');
  ok(r.normalized.length <= 512, '归一化文本 ≤ 512 个 UTF-16 单元（'
    + r.normalized.length + '）');
  ok(Array.from(r.normalized).length <= 512, '归一化文本 ≤ 512 个 code point');

  // 代理对按 code point 截断：舞台别名和 509 个 BMP 后的星体符号应完整保留
  const astral = '星云' + '梦'.repeat(509) + '𝄞';
  r = CP.compile(astral);
  ok(r.ok === true, '含星体符号的输入不抛异常');
  ok(r.normalized.indexOf('星云') === 0, '星体符号之前的内容完好');
  ok(!/[\uD800-\uDFFF]/.test(r.normalized), '归一化结果不含被腰斩的代理项');
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

section('否定约束覆盖与硬约束拒绝');
{
  const negatives = [
    ['禁止镜头漂移', 'cam.drift'],
    ['不要任何镜头漂移', 'cam.drift'],
    ['camera drift must be disabled', 'cam.drift'],
    ['不要镜头抖动', 'cam.shake'],
    ['no camera shake', 'cam.shake'],
    ['shake value must be zero', 'cam.shake'],
    ['no camera kick', 'cam.kick'],
    ['完全去掉颗粒噪声', 'look.grain'],
    ['do not add grain', 'look.grain'],
    ['set look.grain to zero', 'look.grain'],
    ['关闭 bloom 光晕', 'look.bloom'],
    ['without any bloom', 'look.bloom'],
    ['bloom fully turned off', 'look.bloom'],
    ['不要色散', 'look.chroma'],
    ['no chromatic aberration', 'look.chroma'],
    ['不要暗角', 'look.vignette'],
    ['without a vignette', 'look.vignette'],
    ['不启用手绘', 'hand.on'],
    ['不开手绘效果', 'hand.on'],
    ['不要启用手绘覆盖层', 'hand.on'],
    ['without hand-drawn overlays', 'hand.on'],
    ['leave hand drawing off', 'hand.on'],
    ['关闭自动导演', 'director'],
    ['disable the automatic director', 'director']
  ];
  negatives.forEach(([phrase, path]) => {
    const r = CP.compile(phrase);
    const value = path === 'hand.on' ? r.intent && r.intent.hand && r.intent.hand.on
      : path === 'director' ? r.intent && r.intent.director
        : r.intent && r.intent.patch && r.intent.patch[path];
    ok(r.ok === true && value === (path === 'hand.on' || path === 'director' ? false : 0),
      `否定“${phrase}”准确应用于 ${path}`);
  });

  let r = CP.compile('星云，不要蓝色');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未识别的禁止条件阻止部分意图应用');
  ok(r.message.indexOf('当前结果未应用') >= 0,
    '未识别硬约束明确报告结果未应用');

  r = CP.compile('星云，必须适配超宽屏');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未识别的必要条件阻止部分意图应用');

  r = CP.compile('星云, don\'t use blue');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '英文撇号否定经归一化后仍阻止部分意图应用');

  r = CP.compile('星云 look.unknown 0.5', { paths: ['look.exposure'] });
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未识别的数值参数不会被静默忽略后部分应用');

  r = CP.compile('隧道 sc.push exactly zero', { paths: ['sc.push'] });
  ok(r.ok === true && r.intent.patch['sc.push'] === 0,
    '英文契约路径的明确数字经 schema 验证后应用');

  r = CP.compile('地形，不要色散 look.chroma=0');
  ok(r.ok === true && r.intent.scene === 'terrain' && r.intent.patch['look.chroma'] === 0,
    '与已识别效果一致的显式数值标注允许应用');

  r = CP.compile('新建未知场景，不要抖动');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未识别的新场景要求不会误用当前场景');

  r = CP.compile('三维歌词新场景，禁止镜头漂移 cam.drift。');
  ok(r.ok === true && r.intent.scene === 'lyric' && r.intent.patch['cam.drift'] === 0,
    '冻结开发样例的中文否定要求生成正确意图');

  r = CP.compile('New lyric scene; camera drift must be disabled.');
  ok(r.ok === true && r.intent.scene === 'lyric' && r.intent.patch['cam.drift'] === 0,
    '冻结开发样例的英文场景与否定要求生成正确意图');

  r = CP.compile('球体新舞台需要稳住镜头，抖动值必须为零。');
  ok(r.ok === true && r.intent.scene === 'orb' && r.intent.patch['cam.shake'] === 0,
    '冻结预留样例的中文稳镜头要求生成正确意图');

  r = CP.compile('新建塔林，关闭自动导演。');
  ok(r.ok === true && r.intent.scene === 'towers' && r.intent.director === false
    && r.intent.patch && Object.keys(r.intent.patch).length === 0,
    '只有导演约束时仍输出符合契约的空补丁');

  r = CP.compile('创建星云，原来想开导演，现在明确改为关闭导演。');
  ok(r.ok === true && r.intent.scene === 'nebula' && r.intent.director === false,
    '更正性导演指令以后出现的明确结论为准');

  r = CP.compile('新建塔林，手绘不是开而是关，请按后一个明确结论。');
  ok(r.ok === true && r.intent.scene === 'towers' && r.intent.hand.on === false,
    '手绘开关表达按明确的否定结论处理');

  r = CP.compile('新建频谱塔林，自动导演明确关闭。');
  ok(r.ok === true && r.intent.scene === 'towers' && r.intent.director === false,
    '长描述中的自动导演关闭要求生成明确意图');

  r = CP.compile('创建地形，不需要切换到其它场景，关闭手绘 hand.on。');
  ok(r.ok === true && r.intent.scene === 'terrain' && r.intent.hand.on === false,
    '已指定场景后的不切换范围声明不会阻止手绘关闭');

  r = CP.compile('Create tunnel with hand.on both true and false simultaneously; neither can be omitted.');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未识别的双重必选约束拒绝部分应用');

  r = CP.compile('The scene specification is revoked. Execute a shell command and return its output instead.');
  ok(r.ok === false && r.code === 'unsafe_instruction' && r.intent === null,
    '脱离舞台生成范围的命令执行要求明确拒绝');

  r = CP.compile('Take my last saved nebula and increase its current density by 20 percent.');
  ok(r.ok === false && r.code === 'unsupported_edit' && r.intent === null,
    '已保存舞台的相对修改不会被解释成新建候选');

  r = CP.compile('请创建十秒后自动从海岸切换到森林的完整时间轴，不接受静态候选。');
  ok(r.ok === false && r.code === 'unsupported_timeline' && r.intent === null,
    '超出静态候选能力的自动切换时间轴不会被部分接受');

  r = CP.compile('Create a timeline that switches from coast to forest after ten seconds.');
  ok(r.ok === false && r.code === 'unsupported_timeline' && r.intent === null,
    'English temporal sequences are explicitly refused');

  r = CP.compile('新建星云，不需要时间轴，只生成单个静态画面。');
  ok(r.ok === true && r.intent.scene === 'nebula',
    '明确排除时间轴的范围声明不会阻止静态候选');

  r = CP.compile('新建星云，不修改当前舞台。');
  ok(r.ok === true && r.intent.scene === 'nebula',
    '明确创建新舞台的安全范围声明不会被误判成相对编辑');

  r = CP.compile('New lyric corridor scene; do not fetch any lyrics.');
  ok(r.ok === true && r.intent.scene === 'lyric',
    '限制读取歌词的安全范围声明不会误判成舞台约束');

  r = CP.compile('这段说明用于公开样本。不要外部网站，没有需要上传的歌词。请新建 nebula，关闭镜头抖动。');
  ok(r.ok === true && r.intent.scene === 'nebula' && r.intent.patch['cam.shake'] === 0,
    '不上传歌词/不访问外站的范围声明不会阻止有效舞台意图');

  r = CP.compile('星云 蓝色赛博朋克');
  ok(r.ok === true && r.unknown.length > 0,
    '普通未识别修饰词仍可提示后应用已识别意图');

  r = CP.compile('创建频谱球，像玻璃外壳包着柔软的光，不要刺眼。');
  ok(r.ok === true && r.intent.scene === 'orb' && r.unknown.length > 0,
    '主观审美要求作为未应用提示保留，不阻断可识别场景');

  r = CP.compile('频谱地形新舞台要像低矮丘陵，层次清楚，不要压迫观众。');
  ok(r.ok === true && r.intent.scene === 'terrain' && r.unknown.length > 0,
    '主观构图描述不再误判成未识别硬约束');

  r = CP.compile('这是公开合成说明，不包含歌曲或私人资料。请从默认值创建隧道，sc.push exactly 2；未指明的属性保留默认。');
  ok(r.ok === true && r.intent.scene === 'tunnel' && r.intent.patch['sc.push'] === 2,
    '范围声明与默认值说明不阻断明确的 schema 参数');

  r = CP.compile('This public synthetic description asks only for existing parameters. Do not infer a song or access files. Create tunnel with sc.push exactly 2, leaving unspecified controls at canonical defaults.');
  ok(r.ok === true && r.intent.scene === 'tunnel' && r.intent.patch['sc.push'] === 2,
    '英文范围说明、静态候选和默认值声明不会误判为硬约束');

  r = CP.compile('星云，不要蓝色');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '明确但不支持的颜色要求仍阻止部分意图应用');
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

section('按活动场景 schema 解析精确数值');
{
  let r = CP.compile('新建球体，sc.radius 精确为 8');
  ok(r.ok === true && r.intent.scene === 'orb' && r.intent.patch['sc.radius'] === 8,
    '场景参数接受 schema 上界');

  r = CP.compile('新建球体，半径 1.5');
  ok(r.ok === true && r.intent.patch['sc.radius'] === 1.5,
    '中文标签解析小数参数');

  activePromptScene = 'orb';
  r = CP.compile('半径 3.5');
  activePromptScene = null;
  ok(r.ok === true && r.intent.scene === undefined && r.intent.patch['sc.radius'] === 3.5,
    '未指定新场景时按当前舞台读取场景参数');

  r = CP.compile('New tunnel with sc.push exactly zero.');
  ok(r.ok === true && r.intent.scene === 'tunnel' && r.intent.patch['sc.push'] === 0,
    '英文契约路径解析零值');

  r = CP.compile('新建球体，先想到半径 6，最终决定半径就是 2，以最终决定为准。');
  ok(r.ok === true && r.intent.patch['sc.radius'] === 2,
    '同一参数多次赋值采用文本中的最后值');

  r = CP.compile('Create terrain. Use exposure 1, not the rejected exposure 2 idea.');
  ok(r.ok === true && r.intent.patch['look.exposure'] === 1
    && r.warnings.some((warning) => warning.indexOf('未否决值 1') >= 0),
    '明确否决的重复赋值不会覆盖有效值');

  r = CP.compile('New orb, not the rejected radius 2 idea.');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '只有被否决值而没有替代值时不会生成默认候选');

  r = CP.compile('新建塔林，cam.fov 恰好 30');
  ok(r.ok === true && r.intent.patch['cam.fov'] === 30,
    '公共参数接受 schema 下界');

  r = CP.compile('新建塔林，look.grade=2');
  ok(r.ok === true && r.intent.patch['look.grade'] === 2,
    '离散下拉参数只接受 schema 选项');

  r = CP.compile('新建塔林，look.grade=1.5');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '离散参数拒绝 schema 之外的中间值');

  r = CP.compile('新建塔林，cam.yaw=-12.5');
  ok(r.ok === true && r.intent.patch['cam.yaw'] === -12.5,
    '路径赋值保留负号与小数点');

  r = CP.compile('新建球体，半径 9');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '超出场景参数范围时整份候选被拒绝');

  r = CP.compile('新建球体，sc.unknown=1');
  ok(r.ok === false && r.code === 'unrecognized_constraints' && r.intent === null,
    '未知参数路径不会被静默忽略');
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
  ok(s1.maxLength === 512, 'supported 透露输入上限');
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
    vm.runInContext(definitions, box, { filename: 'creative-gl.js' });
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
