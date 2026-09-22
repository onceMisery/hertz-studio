#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 网易云扫码登录诊断：取 unikey → 弹出二维码 → 每 2s 轮询并实时打印状态。
//
// 用法：
//   node scripts/diag-netease-qr.js                    # 默认 type=1，裸请求头
//   node scripts/diag-netease-qr.js --type=3 --ref     # type=3 + 客户端标识头（推荐先试这个）
//   node scripts/diag-netease-qr.js --type=3 --ref --ua=iphone
//
// `--ref` 加上 PC 客户端的 os/appver/osver/channel/versioncode 标识（上游从
// Cookie 头读）。只带 NMTID 时手机确认后上游回 8821「升级新版本再试」，
// 永远进不了 803。
//
// 看什么：
//   801 → 802 → 803 这条链有没有走完；走到 803 时 Set-Cookie 里有没有 MUSIC_U。
//   一直停在 801：手机端的确认没关联到这个 unikey（身份/type/二维码内容问题）。
//   停在 802 不进 803：手机上没点「确认」，或 App 把二维码当普通网页打开了。
//   到 803 但没有 MUSIC_U：上游没下发凭据，本项目判未登录是对的。
//
// 只打印 cookie 的名字，绝不打印值。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');

const argType = (process.argv.find((a) => a.startsWith('--type=')) || '--type=1').slice(7);
const useRef = process.argv.includes('--ref');
const uaMode = (process.argv.find((a) => a.startsWith('--ua=')) || '--ua=browser').slice(5);
const UA =
  uaMode === 'iphone'
    ? 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const W = 'https://music.163.com';

/// PC 客户端标识：与 netease.rs 的 qr_client_cookie() 同形。
function clientCookie() {
  const secs = Math.floor(Date.now() / 1000);
  const f = {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
    deviceId: '',
    versioncode: '140',
    mobilename: '',
    buildver: String(secs),
    resolution: '1920x1080',
    __csrf: '',
    requestId: `${secs}_${String(secs % 1000).padStart(4, '0')}`,
  };
  return Object.entries(f)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('; ');
}

function loadQrLib() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'crates', 'vmusicd', 'web', 'vendor', 'qrcode.js'),
    'utf8'
  );
  const sandbox = { window: {}, Math, String, Number, Array, Object, Error };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.qrcode;
}

function cookiePairs(res) {
  // Node 的 Headers 会把多个 set-cookie 合并，用 getSetCookie() 拿原始数组；
  // 只取每段的第一节，即 name=value。
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return raw.map((c) => c.split(';')[0]);
}

function cookieNames(res) {
  return cookiePairs(res).map((p) => p.split('=')[0]);
}

function namesOf(pairs) {
  return pairs.map((p) => p.split('=')[0]);
}

/// 同名覆盖去重，后写生效（与 Rust 侧 absorb_cookies 同口径）。
function dedupe(pairs) {
  const m = new Map();
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) m.set(p.slice(0, i), p.slice(i + 1));
  }
  return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
}

/// 用刚拿到的凭据打一遍登录后才有的接口，确认「登录态保存」这条链路是通的。
async function probeLoggedIn(pairs) {
  const cookie = dedupe(pairs);
  if (!cookie) {
    console.log('[diag] 没有拿到任何 cookie，跳过登录后自检');
    return;
  }
  const h = { 'User-Agent': UA, Referer: W + '/', Cookie: cookie };
  // 账号资料：本项目 netease.rs::account() / playlists() 走的正是这个端点。
  let uid = null;
  try {
    const r = await fetch(`${W}/api/nuser/account/get`, { headers: h });
    const j = await r.json().catch(() => ({}));
    const p = j && j.profile;
    uid = p && p.userId ? p.userId : null;
    console.log(
      `[diag] 账号接口 code=${j.code}${p ? ` 昵称=${p.nickname || '(空)'} vipType=${p.vipType ?? 0} uid=${uid ?? '(无)'}` : ' 无 profile'}`
    );
  } catch (e) {
    console.log(`[diag] 账号接口异常: ${e.message}`);
  }
  // 用户歌单：确认凭据能用于业务接口，而不只是"判已登录"。
  // 参数必须与 netease.rs::playlists() 一致——少了 uid 上游直接回 400。
  if (!uid) {
    console.log('[diag] 拿不到 uid，跳过歌单自检');
    return;
  }
  try {
    const q = `uid=${uid}&limit=100&offset=0&include=true`;
    const r = await fetch(`${W}/api/user/playlist?${q}`, { headers: h });
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j.playlist) ? j.playlist : [];
    console.log(`[diag] 歌单接口 code=${j.code} 数量=${list.length}`);
  } catch (e) {
    console.log(`[diag] 歌单接口异常: ${e.message}`);
  }
}

async function main() {
  const qrcode = loadQrLib();
  console.log(`[diag] type=${argType} 客户端标识头=${useRef ? '有' : '无'} UA=${uaMode}`);
  const cookie = useRef ? clientCookie() : '';
  const keyRes = await fetch(`${W}/api/login/qrcode/unikey?type=${argType}`, {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const keyJson = await keyRes.json();
  const key = keyJson && keyJson.unikey;
  if (!key) {
    console.error('[diag] 取 unikey 失败:', JSON.stringify(keyJson));
    process.exit(1);
  }
  const seed = cookiePairs(keyRes);
  console.log(`[diag] unikey=${key} 创建期 Set-Cookie=[${cookieNames(keyRes).join(',')}]`);

  const scanUrl = `${W}/login?codekey=${key}`;
  const qr = qrcode(0, 'M');
  qr.addData(scanUrl);
  qr.make();
  const out = path.join(__dirname, '..', 'target', '_qr_live.html');
  fs.writeFileSync(
    out,
    `<!doctype html><meta charset="utf-8"><title>网易云扫码诊断</title>` +
      `<body style="margin:0;background:#0f1115;color:#e8eaed;font-family:system-ui,'Microsoft YaHei',sans-serif;` +
      `display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center">` +
      `<div style="font-size:20px;font-weight:600;margin-bottom:6px">网易云扫码登录 · 诊断</div>` +
      `<div style="font-size:13px;opacity:.65;margin-bottom:18px">用<b>网易云音乐 App</b> 扫，并在手机上点确认</div>` +
      `<div style="display:inline-block;padding:14px;background:#fff;border-radius:12px;line-height:0">` +
      qr.createSvgTag({ cellSize: 6, margin: 2 }) +
      `</div><div style="font-size:12px;opacity:.5;margin-top:16px;font-family:Consolas,monospace">type=${argType}</div>` +
      `</div></body>`
  );
  console.log(`[diag] 二维码已生成: ${out}`);
  execFile('explorer', [out], () => {});
  console.log('[diag] 请立刻用网易云音乐 App 扫码确认，下方实时打印轮询结果：\n');

  const deadline = Date.now() + 5 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    // 轮询回传创建期的 NMTID，再叠加客户端标识（顺序无关）。
    const sent = [cookie, seed.join('; ')].filter((s) => s).join('; ');
    const res = await fetch(`${W}/api/login/qrcode/client/login?key=${key}&type=${argType}`, {
      headers: { 'User-Agent': UA, Referer: W + '/', Cookie: sent },
    });
    const body = await res.json().catch(() => ({}));
    const names = cookieNames(res);
    const line = `${new Date().toLocaleTimeString()} code=${body.code} ${body.message || ''} Set-Cookie=[${names.join(',')}]`;
    // 只在变化或拿到凭据时打印，避免刷屏。
    if (line.replace(/^\S+/, '') !== last) {
      console.log(line);
      last = line.replace(/^\S+/, '');
    }
    if (body.code === 803) {
      const names = namesOf(cookiePairs(res));
      console.log(`\n[diag] 已确认。MUSIC_U=${names.includes('MUSIC_U') ? '有' : '没有'}`);
      console.log(`[diag] 凭据字段: ${[...new Set(names)].join(', ')}`);
      // 顺带用这次拿到的凭据验一遍登录后的链路：账号资料 + 用户歌单。
      // cookie 只在内存里，不落盘、不打印值。
      await probeLoggedIn(cookiePairs(res));
      return;
    }
    // 800 过期，8821「请切换其他登录方式或升级新版本再试」等终局业务码：
    // 都不是再等就能变好的状态，停下免得刷屏。
    if (body.code !== 801 && body.code !== 802) {
      console.log(`\n[diag] 终局业务码 ${body.code}（${body.message || '无说明'}），停止轮询。`);
      console.log('[diag] 换个参数组合再跑一次：--type=3 --ref / --ua=iphone');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('\n[diag] 5 分钟超时，未等到确认。');
}

main().catch((e) => {
  console.error('[diag] 异常:', e.message);
  process.exit(1);
});
