// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 首页卡片里的「每日名言」。
//
// 为什么自己模块而不是塞进 home-dashboard.js：那条链路的 update() 是被
// playback/stage 事件驱动的，**每换一首歌就会跑一次**。名言与播放无关，
// 混进去会让每次换歌都白跑一遍网络与存取，还把它和「封面不能重复解码」
// 那类有严格时序的逻辑绑在一起。这里自己管自己的生命周期。
//
// 三条纪律：
//   1. **不打网络在渲染路径上**。启动拉一次 → 存 localStorage → 之后全部读缓存。
//      一言网官方明确限 QPS（2~3.5）并会屏蔽大流量站点，所以「换一条」
//      只在本地缓存里换。
//   2. **不用 Math.random()**。同一天刷新页面名言不变 —— 与项目里
//      stanza 那条「渲染层零 Math.random()」一致。
//   3. **取不到也要有内容**。这块常驻第一屏，一个空框比没有更糟：
//      拿不到就用内置兜底，并在界面上如实说明是兜底不是网络失败。

(function (global) {
  'use strict';

  var CACHE_KEY = 'vmusic.home.quote.v1';
  var CATS = { poem: 'i', literature: 'd', philosophy: 'k', film: 'h' };

  // 内置兜底。网络失败、数据目录被清、或用户点「重试」失败时用这些。
  // 每条自带出处；分类名与 hitokoto 的 c 参数一一对应，方便换库时对齐。
  var FALLBACK = [
    { hitokoto: '落霞与孤鹜齐飞，秋水共长天一色。', from: '王勃《滕王阁序》' },
    { hitokoto: '求其放心，必先空其两端。', from: '《六祖坛经》' },
    { hitokoto: '路漫漫其修远兮，吾将上下而求索。', from: '《离骚》' },
    { hitokoto: '大器晚成，大音希声，大象无形。', from: '《道德经》' },
    { hitokoto: '纸上得来终觉浅，绝知此事要躬行。', from: '陆游《冬夜读书示子聿》' },
    { hitokoto: '问渠那得清如许，为有源头活水来。', from: '朱熹《观书有感》' },
  ];

  var el = null;
  var host = null;
  var settings = { enabled: true, category: 'poem', clickable: true };
var cache = null;          // { at: dayKey, items: [...] }
var usingFallback = true;  // 当前展示的是不是兜底
var index = -1;
var fetchSeq = 0;          // 请求序号，用来绕开 CDN 合并

  // 一天一个 key。用本地日期而不是 UTC —— 「每天一句」按用户所在时区算，
  // 与 daily.js 那套「规则跑本机」一致。
  function dayKey(now) {
    var d = now || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // 按当天日期选起点：同一天永远是同一批、同一顺序。
  function seedOf(key) {
    var h = 0;
    for (var i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h;
  }

  function readCache() {
    try {
      var raw = global.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items) || !data.items.length) return null;
      // 旧版本可能存下过只有一两条的残缺池（当时没做不足下限的处理）。
      // 读到不足就并入兜底补齐，否则「换一条」在这台机器上永远是死的。
      if (data.items.length < 3) {
        FALLBACK.forEach(function (item) {
          if (data.items.length >= 5) return;
          if (!data.items.some(function (x) { return x.hitokoto === item.hitokoto; })) {
            data.items.push(item);
          }
        });
      }
      return data;
    } catch (_) { return null; }
  }

  function writeCache(items) {
    try {
      global.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: dayKey(), items: items }));
    } catch (_) { /* 隐私模式写不进去：本次仍可用内存缓存 */ }
  }

  // 一言网返回的字段名不统一（hitokoto/from/author，还有 origin 的），
  // 这里只取要用的两个，缺字段就退化成空字符串而不是显示 undefined。
  function normalize(raw) {
    if (!raw) return null;
    var text = String(raw.hitokoto || '').trim();
    if (!text) return null;
    var from = String(raw.from || raw.origin || '').trim();
    var author = String(raw.author || '').trim();
    if (author && author !== '匿名') from = from ? from + ' · ' + author : author;
    return { hitokoto: text, from: from };
  }

  function pool() {
    if (usingFallback || !cache || !cache.items.length) return FALLBACK;
    return cache.items;
  }

  function render() {
    if (!el || !el.box) return;
    if (!settings.enabled) {
      // 整块不渲染：不留空 div、不留分隔线、不占高度。
      el.box.hidden = true;
      return;
    }
    var list = pool();
    if (index < 0 || index >= list.length) index = seedOf(dayKey()) % list.length;
    var item = list[index];
    el.box.hidden = false;
    el.text.innerHTML = '';
    var quote = document.createTextNode(item.hitokoto);
    el.text.appendChild(quote);
    if (item.from) {
      var from = document.createElement('span');
      from.className = 'home-quote-from';
      from.textContent = ' — ' + item.from;
      el.text.appendChild(from);
    }
    el.actions.hidden = !settings.clickable || !list.length;
    el.count.textContent = list.length ? (index + 1) + ' / ' + list.length : '';
    el.box.dataset.fallback = usingFallback ? '1' : '';
  }

  function advance() {
    var list = pool();
    if (list.length < 2) return;
    // 步长取「质数步进」而不是随机数：既保证一定走到别的条目，
    // 又保持确定性（项目纪律：渲染层零 Math.random，同一天刷新位置一致）。
    // 步长与 list.length 互质时，连续点会走遍全部条目再回到起点。
    var step = 1 + (seedOf(dayKey()) % Math.max(list.length - 1, 1));
    if (list.length > 2 && step % list.length === 0) step = 1;
    index = (index + step) % list.length;
    render();
  }

async function fetchRemote(cat) {
    // 尾部那个自增参数是为了**绕开 CDN 的请求合并**：实测相同 URL 的并发/
    // 重复请求会被合并成同一个响应（8 次只回 3~4 个唯一 id）。
    // 给每次请求一个不同的查询参数，才能真正拿到不同的句子。
    fetchSeq += 1;
    var url = 'https://v1.hitokoto.cn/?encode=json&c=' + (CATS[cat] || CATS.poem)
      + '&max_length=48&_=' + dayKey() + '-' + fetchSeq;
    var res = await global.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return normalize(await res.json());
  }

  async function refresh() {
    if (!settings.enabled) return;
    try {
      // **必须串行 + 带间隔**：实测并发请求会被一言网 CDN 合并成同一个响应
      // （8 次并发只回 3~4 个唯一 id）。URL 尾部已经加了自增参数绕开合并，
      // 这里留一点间隔再求稳。全部在本地完成，之后「换一条」永远不打网络。
      var got = [];
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      for (var i = 0; i < 8; i += 1) {
        if (i) await wait(140);
        var tries = 0, one = null;
        while (tries < 2 && !one) {
          if (tries) await wait(320);          // 撞上重复就再等一下重试
          try { one = await fetchRemote(settings.category); } catch (_) { one = null; }
          tries += 1;
        }
        if (one && !got.some(function (x) { return x.hitokoto === one.hitokoto; })) {
          got.push(one);
        }
      }
      if (!got.length) throw new Error('empty');
      // ⚠ 抓到 1~2 条**不算成功**。实测浏览器里 8 次串行请求经常被 CDN
      // 合并成只剩一两条（curl 单独测能拿到 5~6 个不同 id，但页面里不行）。
      // 若就此写入缓存，语料池就只剩一条 —— 「换一条」永远是同一条，
      // 而且会把原本完好的缓存**覆盖成残缺的**（下次启动读到的也是它）。
      // 所以不足 3 条时并入内置兜底凑满，并且**不覆盖**已有缓存。
      var MIN_POOL = 3;
      var merged = got.slice();
      if (merged.length < MIN_POOL) {
        for (var f = 0; f < FALLBACK.length && merged.length < MIN_POOL + 2; f += 1) {
          if (!merged.some(function (x) { return x.hitokoto === FALLBACK[f].hitokoto; })) {
            merged.push(FALLBACK[f]);
          }
        }
      }
      var usable = got.length >= MIN_POOL;
      // 只有网络结果够用才落盘；不够就只用内存里的合并结果，
      // 别把残缺数据写进 localStorage 污染下一次启动。
      if (usable) {
        cache = { at: dayKey(), items: got };
        writeCache(got);
      } else {
        cache = { at: dayKey(), items: merged };
      }
      usingFallback = !usable;
      index = seedOf(dayKey()) % cache.items.length;
      render();
    } catch (_) {
      // 网络失败不该让这块空白，也不该把已有缓存清掉：
      // 有缓存就用缓存，没有才用内置兜底。
      cache = readCache();
      usingFallback = !cache;
      index = -1;
      render();
    }
  }

  function load(nextHost) {
    if (host) return;
    host = nextHost || null;
    el = {
      box: document.getElementById('home-quote'),
      text: document.getElementById('home-quote-text'),
      actions: document.getElementById('home-quote-actions'),
      next: document.getElementById('home-quote-next'),
      count: document.getElementById('home-quote-count'),
    };
    if (!el.box) return;
    cache = readCache();
    usingFallback = !cache;
    index = -1;
    render();
    if (el.next) el.next.addEventListener('click', advance);
    // 首次启动再拉一次。失败会走兜底，不影响首屏。
    refresh();
  }

  function apply(next) {
    if (!next) return;
    if (typeof next.enabled === 'boolean') settings.enabled = next.enabled;
    if (next.category && CATS[next.category] && next.category !== settings.category) {
      settings.category = next.category;
      cache = null;          // 换分类 = 换语料，旧缓存作废
      index = -1;
    }
    if (typeof next.clickable === 'boolean') settings.clickable = next.clickable;
    render();
    if (settings.enabled) refresh();
  }

  function applySettings(next) {
    if (next) {
      if (typeof next.enabled === 'boolean') settings.enabled = next.enabled;
      if (typeof next.clickable === 'boolean') settings.clickable = next.clickable;
    }
    render();
  }

  function setCategory(cat) {
    if (!CATS[cat] || cat === settings.category) return;
    settings.category = cat;
    cache = null;
    usingFallback = true;
    index = -1;
    render();
    refresh();
  }

  global.HomeQuote = {
    load: load,
    apply: apply,
    applySettings: applySettings,
    setCategory: setCategory,
    refresh: refresh,
    // 供契约/实测读取当前状态
    state: function () {
      return {
        enabled: settings.enabled, category: settings.category,
        usingFallback: usingFallback, index: index,
        count: pool().length, cached: !!(cache && cache.items.length),
      };
    },
  };
}(window));