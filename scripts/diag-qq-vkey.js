#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// QQ 音乐取流诊断：用库里已保存的真实凭据跑 CgiGetVkey，对比「修复前 /
// 修复后」两种请求形态，统计 purl 命中率。
//
// 用法：
//   node scripts/diag-qq-vkey.js                       # 默认关键词组，各取若干首免费曲目
//   node scripts/diag-qq-vkey.js --kw=茉莉花 --n=5     # 指定关键词与样本数
//   node scripts/diag-qq-vkey.js --songmid=0039MnYb0qxYhV --media=003Qui1q2u1Zho
//   node scripts/diag-qq-vkey.js --db=C:\path\to\vmusic.db
//
// 看什么：
//   before 一列的 0/3 且 midurlinfo 里第 2 项起 songmid 为空 → 就是
//   songmid/songtype 数组没与 filename 等长的老问题（服务端回 101404）。
//   after 一列非 0 即修复生效。
//   两列全 0 且每项 result=104003 → 该曲目确实要 VIP/付费，不是本项目的 bug。
//
// 只打印凭据的长度，绝不打印值。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const KW = (arg('kw', '茉莉花,童年,大海,朋友') || '').split(',').filter(Boolean);
const N = Math.max(1, Math.min(20, Number(arg('n', '8')) || 8));
const ONLY_MID = arg('songmid', '');
const ONLY_MEDIA = arg('media', '');
const DB = arg(
  'db',
  path.join(
    os.homedir(),
    'AppData',
    'Local',
    'hertz-studio',
    'vmusic.db'
  )
);

const QUALITIES = [
  ['RS01', '.flac', 700000],
  ['F000', '.flac', 700000],
  ['M800', '.mp3', 320000],
  ['M500', '.mp3', 128000],
  ['C400', '.m4a', 96000],
];

function mask(s, keep = 3) {
  if (!s) return '(empty)';
  return s.length > keep ? s.slice(0, keep) + '...(len=' + s.length + ')' : '*'.repeat(s.length);
}

function tiersFor(quality, mediaIds) {
  let start = QUALITIES.findIndex((q) => quality >= q[2]);
  if (start < 0) start = QUALITIES.length - 1;
  const out = [];
  for (const m of mediaIds) {
    for (const [p, e, b] of QUALITIES.slice(start)) out.push([p + m + e, b]);
  }
  return out;
}

async function postMusicu(body, cookie) {
  const res = await fetch(MUSICU, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json;charset=UTF-8',
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function search(kw) {
  const u =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=6&w=' +
    encodeURIComponent(kw) +
    '&format=json&platform=mac&new_json=1';
  const res = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } });
  const j = await res.json();
  const list = (j && j.data && j.data.song && j.data.song.list) || [];
  return list.map((s) => ({
    songmid: s.mid || s.songmid,
    media: (s.file && s.file.media_mid) || s.media_mid || s.mid || s.songmid,
    name: s.name,
    pay: s.pay ? s.pay.pay_play : undefined,
  }));
}

function readCred() {
  if (!fs.existsSync(DB)) throw new Error('找不到数据库: ' + DB);
  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare("SELECT value FROM settings WHERE key='online_cred_qq'").get();
  const dev = db.prepare("SELECT value FROM settings WHERE key='online_device_qq'").get();
  db.close();
  if (!row) throw new Error('库里没有 online_cred_qq，先在客户端登录 QQ 音乐');
  const pack = JSON.parse(row.value);
  const cookie = pack.cookie || '';
  let authst = '';
  for (const p of cookie.split(';')) {
    const t = p.trim();
    if (t.startsWith('qm_keyst=')) authst = t.slice(9);
  }
  return { cookie, uin: pack.uin || '0', authst, guid: dev ? JSON.parse(dev.value) : '8345432780' };
}

function call(cred, param) {
  const comm = { uin: cred.uin, format: 'json', cv: 0, ct: cred.authst ? 19 : 24 };
  if (cred.authst) comm.authst = cred.authst;
  return postMusicu(
    { comm, req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param } },
    cred.cookie
  );
}

function summarize(j) {
  const d = (j && j.req_0 && j.req_0.data) || {};
  const info = Array.isArray(d.midurlinfo) ? d.midurlinfo : [];
  return { ok: info.filter((e) => e.purl).length, all: info.length, info, sip: (d.sip || [])[0] };
}

async function probeWorking(j) {
  const d = (j && j.req_0 && j.req_0.data) || {};
  const infos = Array.isArray(d.midurlinfo) ? d.midurlinfo : [];
  const sips = (d.sip || []).filter(Boolean);
  const candidates = [];
  for (const info of infos) {
    const purl = info && info.purl;
    if (!purl) continue;
    for (const sip of sips) candidates.push(joinUrl(sip, purl));
  }
  if (!candidates.length) return { probeOk: 0, probeAll: 0, first: null };
  const results = await Promise.all(
    candidates.map(async (url) => {
      try {
        const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } });
        return { url, ok: r.ok };
      } catch (e) {
        return { url, ok: false };
      }
    })
  );
  const ok = results.filter((x) => x.ok);
  return { probeOk: ok.length, probeAll: candidates.length, first: ok[0] && ok[0].url };
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

(async () => {
  const cred = readCred();
  console.log('凭据: uin=' + mask(cred.uin) +
    ' qm_keyst=' + mask(cred.authst) + ' guid=' + cred.guid);

  let songs = [];
  if (ONLY_MID) {
    songs = [{ songmid: ONLY_MID, media: ONLY_MEDIA || ONLY_MID, name: '(指定曲目)', pay: undefined }];
  } else {
    for (const kw of KW) {
      try {
        songs = songs.concat(await search(kw));
      } catch (e) {
        console.log('搜索 ' + kw + ' 失败: ' + e.message);
      }
    }
    // 优先挑 pay=0（非 VIP）曲目，最能反映「免费歌播不了」的问题。
    const free = songs.filter((s) => s.pay === 0);
    songs = (free.length ? free : songs).slice(0, N);
  }
  console.log('样本: ' + songs.length + ' 首\n');
  console.log(pad('曲目', 22) + pad('before', 14) + pad('after', 14) + 'probe');
  console.log('-'.repeat(70));

  let beforeOk = 0;
  let afterOk = 0;
  let probeOk = 0;
  for (const s of songs) {
    const mediaIds = s.media === s.songmid ? [s.songmid] : [s.media, s.songmid];
    // before：filename 多档但 songmid/songtype 只有 1 个（历史形态）。
    const oldFn = QUALITIES.slice(2).map(([p, e]) => p + s.media + e);
    let b = { ok: 0, all: 0 };
    try {
      b = summarize(
        await call(cred, {
          guid: cred.guid,
          songmid: [s.songmid],
          songtype: [0],
          uin: cred.uin,
          loginflag: 1,
          platform: '20',
          filename: oldFn,
        })
      );
    } catch (e) {
      /* 计 0 */
    }
    // after：三数组等长 + media_mid/songmid 双候选（当前实现）。
    const tiers = tiersFor(320000, mediaIds);
    const newFn = tiers.map((t) => t[0]);
    let a = { ok: 0, all: 0, info: [] };
    let p = { probeOk: 0, probeAll: 0, first: null };
    try {
      const j = await call(cred, {
        guid: cred.guid,
        songmid: new Array(newFn.length).fill(s.songmid),
        songtype: new Array(newFn.length).fill(0),
        uin: cred.uin,
        loginflag: 1,
        platform: '20',
        filename: newFn,
      });
      a = summarize(j);
      p = await probeWorking(j);
    } catch (e) {
      /* 计 0 */
    }
    if (b.ok) beforeOk++;
    if (a.ok) afterOk++;
    if (p.probeOk) probeOk++;
    const codes = new Set((a.info || []).map((e) => e.result));
    console.log(
      pad(String(s.name || '').slice(0, 20), 22) +
        pad(b.ok + '/' + b.all + (b.ok ? ' hit ' + String(b.info.find((e) => e.purl).filename).slice(0, 4) : ''), 14) +
        pad(a.ok + '/' + a.all + (a.ok ? '' : ' result=' + [...codes].join(',')), 14) +
        p.probeOk + '/' + p.probeAll
    );
  }
  console.log('-'.repeat(70));
  console.log('可播放曲目: before ' + beforeOk + '/' + songs.length +
    '   after ' + afterOk + '/' + songs.length +
    '   probe ' + probeOk + '/' + songs.length);
})().catch((e) => {
  console.error('诊断失败: ' + e.message);
  process.exit(1);
});

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(1, n - s.length));
}
