// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 搜索关键词历史：唯一的 owner。
//
// 为什么要有这一个文件：关键词历史原先住在 `skins/skin.liunian.js` 的一个私有
// localStorage 键里（`vmusic.ln-search-history`）。后果是「搜索历史跟着皮肤走」——
// 在顶栏曲库框或在线搜索框里敲的词不会进来，换到别的皮肤就什么都看不见，而
// 搜索能力本身是共用的。清单 §9 G10 讲的正是这件事：历史属于**搜索**，不属于
// 某个界面。
//
// 三条边界：
//
//   1. 只有一个键，且带版本（`vmusic.search-history` = `{v:1, items:[…]}`）。
//      旧键一次性搬进来并删掉，不留「两份历史哪份是当前的」这种问题。
//   2. 历史 ≠ 结果缓存。这里只存用户敲过的词；搜到的东西另有 owner
//      （`online.js` 的聚合搜索与曲库列表），不要把两边混成一份。
//   3. `vmusic.palette.recent` 存的是**命令 id**，不是关键词，不并进来 —— 名字
//      像但不是同一个东西。
window.HertzSearchHistory = (function () {
  'use strict';

  var KEY = 'vmusic.search-history';
  var OLD_KEYS = ['vmusic.ln-search-history'];
  var VERSION = 1;
  var MAX = 10;
  var MIN_CHARS = 1;

  function readRaw(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (e) {
      // 存坏了一次都不该把搜索卡住：坏 JSON 当作没有。
      return null;
    }
  }

  /// 现读列表。永远返回 string[]：别的模块拿它渲染，不该再判形状。
  function all() {
    var box = readRaw(KEY);
    if (box && Array.isArray(box.items)) return box.items.filter(isText);
    if (Array.isArray(box)) return box.filter(isText);   // 手改过的旧形状也不炸
    return [];
  }

  function isText(x) {
    return typeof x === 'string' && x.trim().length >= MIN_CHARS;
  }

  /// 大小写与首尾空白不算两条不同记录：「周杰伦」与「 周杰伦 」是同一个意图，
  /// 而重复出现要把它顶回第一位（最近用的那条最有下一次还要用的可能）。
  function same(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  function write(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VERSION, items: items }));
    } catch (e) {
      /* 存不下就是本次会话少一条历史，不该影响搜索本身。 */
    }
  }

  function push(q) {
    q = (q == null ? '' : String(q)).trim();
    if (q.length < MIN_CHARS) return all();
    var rest = all().filter(function (x) { return !same(x, q); });
    var out = [q].concat(rest).slice(0, MAX);
    write(out);
    return out;
  }

  function remove(q) {
    var out = all().filter(function (x) { return !same(x, q); });
    write(out);
    return out;
  }

  function clear() {
    write([]);
  }

  /// 一次性搬迁：把原皮肤私有键里的列表并进这里，然后删掉旧键。搬过的键不再读，
  /// 于是「历史住在哪」在仓库里只有一处答案。
  function migrate() {
    var merged = all();
    var moved = 0;
    OLD_KEYS.forEach(function (key) {
      var old = readRaw(key);
      if (old === null) return;
      var list = (Array.isArray(old) ? old : (old.items || [])).filter(isText);
      list.forEach(function (q) {
        if (merged.some(function (x) { return same(x, q); })) return;
        merged.push(q);
        moved += 1;
      });
      try { localStorage.removeItem(key); } catch (e) { /* 删不掉就是多占几个字节 */ }
    });
    if (moved) write(merged.slice(0, MAX));
    return moved;
  }

  // 载入即搬：所有消费方（流年面板、顶栏、在线框）都只认这一个键。
  migrate();

  return {
    KEY: KEY,
    MAX: MAX,
    VERSION: VERSION,
    all: all,
    push: push,
    remove: remove,
    clear: clear,
    migrate: migrate,
    // 归一判等暴露出去：渲染层要按它决定「这个词是不是已经在表里」。
    same: same,
  };
}());
