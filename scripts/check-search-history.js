#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 搜索关键词历史的 owner 契约检查（零依赖、不触网）。
//
//   node scripts/check-search-history.js
//
// 对应借鉴清单 §9 的 G10。原先关键词历史住在 `skins/skin.liunian.js` 的私有键
// `vmusic.ln-search-history` 里，于是「历史跟着皮肤走」：顶栏与在线框敲的词进
// 不来，换一套皮肤就看不见，而搜索能力本身是共用的。本批把它挪成一个 owner
// （`plugin/ui/search-history.js`），这里钉的是搬完之后不许回头的那些事：
//
//   1. 只有一个键。旧键一次性搬进来并删掉；不许留两处写入，否则「哪份是当前的」
//      又要人来猜。
//   2. 规则也只有一处：trim + 大小写不敏感去重、置顶最近用的、上限 10 条。皮肤
//      侧只保留渲染，别再各写一套去重。
//   3. 记的是**提交**的查询，不是逐字输入。边输边查的框若在每次 oninput 都记，
//      最近十条里全是「周」「周杰」这种中间态。
//   4. 关键词历史 ≠ 结果缓存 ≠ 命令历史。`vmusic.palette.recent` 存的是命令 id，
//      不许并进来；三样东西各有各的 owner。
//
// 规则部分不靠读源码猜：`search-history.js` 整段在 vm 沙箱里执行，喂一个假
// localStorage，按真假时钟与旧键内容跑一遍。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}
function eq(a, b, label) {
  ok(a === b, label + '（期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a) + '）');
}
function section(name) { console.log('\n' + name); }

/// 假 localStorage：够测「写进去 / 读出来 / 删没删」，不假装它是浏览器那套。
function fakeStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/// 把真实模块跑进沙箱，返回它的导出与那份假存储。
function loadModule(seed) {
  const store = fakeStore(seed);
  const ctx = { localStorage: store, JSON, Array, String, Math, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('plugin/ui/search-history.js'), ctx);
  return { H: ctx.window.HertzSearchHistory, store };
}

(function main() {
  section('规则：去重、归一、置顶、上限');
  {
    const { H, store } = loadModule();
    eq(H.MAX, 10, '上限是 10 条');
    H.push('周杰伦');
    H.push('  周杰伦  ');
    eq(H.all().length, 1, '首尾空白不算第二条');
    H.push('周同学');
    H.push('周杰伦');
    eq(H.all()[0], '周杰伦', '重复使用要把那条顶回第一位');
    eq(H.all().length, 2, '置顶不该留下副本');
    H.push('Ab');
    H.push('ab');
    eq(H.all()[0], 'ab', '大小写不算两条，以这次输入的写法为准');
    eq(H.all().length, 3, '去重后总共还是三条');
    for (let i = 0; i < 20; i += 1) H.push('q' + i);
    eq(H.all().length, 10, '超上限只保留最近十条');
    eq(H.all()[0], 'q19', '最新的在最前');
    ok(H.all().indexOf('q0') < 0, '最旧的已被挤掉');
    eq(H.remove('q19').length, 9, '删一条');
    eq(H.all()[0], 'q18', '删的是被点的那条，不是最后一条');
    H.clear();
    eq(H.all().length, 0, '清空');
    H.push('');
    H.push('   ');
    H.push(null);
    H.push(undefined);
    eq(H.all().length, 0, '空与 null 不进历史（否则面板里会出现空白芯片）');
    // 还要真的没写进去。读侧的 isText 过滤是兜底，不能替写入端擦屁股：存储里
    // 躺着空串，换一个消费者渲染时就是一枚空白芯片。
    ok(store.map.has('vmusic.search-history'), '清空时也该落下一个空列表（而不是留旧形状）');
    const rawStored = JSON.parse(store.map.get('vmusic.search-history'));
    eq(rawStored.items.length, 0, '无效输入一条都不该写进存储');
  }

  section('一次性搬迁与容错');
  {
    const { H, store } = loadModule({ 'vmusic.ln-search-history': JSON.stringify(['晴天', '七里香', '晴天']) });
    ok(H.all().indexOf('晴天') >= 0 && H.all().indexOf('七里香') >= 0,
      '旧键里的记录搬进来了');
    eq(H.all().length, 2, '搬迁也要去重（旧数据里可能有重复）');
    eq(store.map.has('vmusic.ln-search-history'), false, '旧键必须删掉：留两处写入就没人知道哪份是当前的');
    eq(H.migrate(), 0, '第二次搬迁不再搬东西');
    eq(H.all().length, 2, '重复调用不许把记录翻倍');
    const saved = JSON.parse(store.map.get('vmusic.search-history'));
    eq(saved.v, 1, '新键带版本');
    ok(Array.isArray(saved.items), '新键的形状是 {v, items}');
  }
  {
    const bad = loadModule({ 'vmusic.search-history': '{nope' });
    eq(bad.H.all().length, 0, '存坏了当作没有，不许把搜索卡住');
    const shape = loadModule({ 'vmusic.search-history': JSON.stringify(['a', 7, null, '']) });
    eq(shape.H.all().length, 1, '手改过的旧形状只留合法字符串项');
    const noStore = { H: null };
    // localStorage 整个不存在（某些隐私模式）时，模块加载与调用都不该抛。
    const ctx = { JSON, Array, String, Math };
    ctx.window = ctx;
    vm.createContext(ctx);
    try {
      vm.runInContext(read('plugin/ui/search-history.js'), ctx);
      noStore.H = ctx.window.HertzSearchHistory;
      noStore.H.push('x');
      eq(noStore.H.all().length, 0, '没有 localStorage 就不记，但也不抛');
    } catch (e) {
      ok(false, '没有 localStorage 时模块不该抛异常：' + e.message);
    }
  }

  section('owner 唯一，且各入口都记到这里');
  {
    const liunian = read('plugin/ui/skins/skin.liunian.js');
    ok(!/HISTORY_KEY/.test(liunian), '流年不再有私有的历史键常量');
    ok(!/localStorage\.(setItem|getItem|removeItem)\([^)]*[Hh]istory/.test(liunian),
      '流年不许再直接读写历史存储（渲染层可以，存储层不行）');
    ok(/window\.HertzSearchHistory/.test(liunian), '流年的四个历史函数都委托给 owner');
    const app = read('plugin/ui/app.js');
    const online = read('plugin/ui/online.js');
    const top = read('plugin/ui/topsearch.js');
    ok(/window\.HertzSearchHistory\.push/.test(app), '顶栏本地档提交时记一笔');
    ok(/window\.HertzSearchHistory\.push/.test(online), '在线搜索执行时记一笔');
    ok(/window\.HertzSearchHistory\.push/.test(top), '顶栏在线/歌单档 Enter 记一笔');
    // 「记的是提交，不是逐字输入」：oninput 那条链上不许出现 push。
    const oninput = /ui\.search\.oninput = \(\) => \{[\s\S]{0,900}?\n  \};/.exec(app);
    ok(oninput, '顶栏 oninput 的处理器抓得到');
    if (oninput) ok(!/HertzSearchHistory/.test(oninput[0]),
      '逐字输入不进历史：否则最近十条全是「周」「周杰」这种中间态');
    const onlineInput = /H\.ui\.onlineQ\.oninput = function \(\) \{[\s\S]{0,500}?\n      \};/.exec(online);
    ok(onlineInput && !/HertzSearchHistory/.test(onlineInput[0]),
      '在线框的 oninput 同样不许记');
    // 只有一个地方写这个键。
    const writers = ['plugin/ui/search-history.js', 'plugin/ui/app.js', 'plugin/ui/online.js',
      'plugin/ui/topsearch.js', 'plugin/ui/skins/skin.liunian.js', 'plugin/ui/palette.js']
      .filter((f) => /'vmusic\.search-history'|"vmusic\.search-history"/.test(read(f)));
    eq(writers.join(','), 'plugin/ui/search-history.js', '键名只在一处出现');
    ok(!/HertzSearchHistory/.test(read('plugin/ui/palette.js')),
      '命令历史（vmusic.palette.recent）不并进来：那是 id，不是关键词');
    const html = read('plugin/ui/index.html');
    const at = html.indexOf('src="search-history.js"');
    ok(at >= 0, 'index.html 引入了 owner 模块');
    ok(at < html.indexOf('src="skins/skin.liunian.js"'),
      '必须排在皮肤之前（defer 按文档顺序执行）');
    ok(at < html.indexOf('src="app.js"'), '也必须排在 app.js 之前');
  }

  console.log(`\n搜索历史契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
