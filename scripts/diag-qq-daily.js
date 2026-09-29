#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 诊断：QQ 音乐到底有没有「每日推荐歌曲」端点？
//
// 背景：`SOURCES` 表里 QQ 没登记 RecommendSongs，注释写的是「QQ 无每日歌曲
// 推荐端点」，于是每日推荐汇总把它判成 unsupported——用户登了 QQ 也照样不出歌。
// 这个脚本就是用来核实那句注释：把候选 module/method 逐个打过去，看上游到底
// 回什么。是"接口不存在"还是"当年没试出来"，得分清楚。
//
// 用法：node scripts/diag-qq-daily.js [cookie]
//   cookie 可选：QQ 登录 cookie（每日推荐多半要登录态）。不给就匿名探一次，
//   至少能区分"模块不存在"和"要登录"。
'use strict';

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

// 候选：公开参考实现里出现过、或按命名规律推的每日推荐模块。
const CANDIDATES = [
  ['music.recommend.DailyRecommend', 'GetDailyRecommend'],
  ['music.recommend.DailyRecommend', 'GetDailyRecommendSong'],
  ['music.recommend.RecommendSong', 'get_recommend_song'],
  ['music.recommend.RecommendSong', 'GetRecommendSong'],
  ['music.recommend.HomeRecommend', 'GetHomeRecommend'],
  ['music.recommend.DailyRecommendSongs', 'GetDailyRecommendSongs'],
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

async function probe(module, method, cookie) {
  const body = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req: {
      module,
      method,
      param: { SwitchEncrypt: 0, SwitchMV: 0 },
    },
  });
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': UA,
    Referer: 'https://y.qq.com/',
  };
  if (cookie) headers.Cookie = cookie;
  const started = Date.now();
  try {
    const res = await fetch(MUSICU, { method: 'POST', headers, body });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    const node = j && (j.req || j[Object.keys(j).find(k => k !== 'comm')] || j);
    const code = node && node.code;
    return {
      module, method, http: res.status, ms: Date.now() - started, code,
      keys: j ? Object.keys(j).join(',') : '',
      hint: (text || '').slice(0, 220),
      dataKeys: node && node.data ? Object.keys(node.data).join(',') : '',
    };
  } catch (err) {
    return { module, method, http: 0, ms: Date.now() - started, code: null, err: String(err) };
  }
}

async function probeRaw(bodyObj, cookie) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': UA,
    Referer: 'https://y.qq.com/',
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(MUSICU, {
    method: 'POST', headers, body: JSON.stringify(bodyObj),
  });
  return { http: res.status, text: (await res.text()).slice(0, 260) };
}

/// 通道自检：用**已实现且能用**的推荐歌单模块打同一条通道。
/// 它若 code=0，说明请求格式没问题，那 500003 就是"模块真不存在"；
/// 它若也 500003，说明是我构造请求的方式不对，下面的结论统统作废。
async function sanity(cookie) {
  console.log('通道自检：已实现的 playlist.PlayListPlazaServer（应该 code=0）');
  const r = await probeRaw({
    comm: { ct: 24, cv: 0 },
    playlist: {
      module: 'playlist.PlayListPlazaServer',
      method: 'get_playlist_by_category',
      param: { id: 3317, curPage: 1, size: 3, order: 5, titleid: 3317 },
    },
  }, cookie);
  console.log(`    http=${r.http}`);
  console.log(`    ${r.text}`);
  console.log();
}

(async () => {
  const cookie = process.argv[2] || '';
  console.log(`QQ 每日推荐端点探测（${cookie ? '带 cookie' : '匿名'}）`);
  console.log('-'.repeat(78));
  await sanity(cookie);
  for (const [module, method] of CANDIDATES) {
    const r = await probe(module, method, cookie);
    const verdict = r.code === 0 ? '★ 有戏' : (r.code === undefined || r.code === null ? '无响应' : `code=${r.code}`);
    console.log(`${module} / ${method}`);
    console.log(`    http=${r.http} ${r.ms}ms  ${verdict}`);
    if (r.dataKeys) console.log(`    data 字段: ${r.dataKeys}`);
    console.log(`    ${r.err || r.hint}`);
    console.log();
  }
  console.log('-'.repeat(78));
  console.log('判读：code=0 且 data 里有歌曲列表 → 端点存在，可以给 QQ 开 RecommendSongs；');
  console.log('      code=1001/3000 之类 → 端点存在但要登录/签名；code=404/5001 → 端点不存在。');
})();
