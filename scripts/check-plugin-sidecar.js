#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// DBX 插件 sidecar 的协议冒烟检查（零依赖）。
//
// 真的把 dbx-plugin-hertz 起起来，用 stdio 喂 JSON-RPC，验证七件事：
//   1. plugin/initialize 握手能过（协议版本协商）；
//   2. 装配链路能跑通——数据目录、SQLite 迁移、音频后端（拿不到设备会回落 null）；
//   3. 门面信封 {status, body} 与 HTTP 版同构；
//   4. 错误体字段名是 request_id（snake_case）而不是 requestId。前端 app.js 的
//      错误归一化直接读这个字段，写错了整条错误链路会静默退化成"没有 request_id"；
//   5. 曲库域端点的契约：分页/排序参数、凭据键过滤、收藏开关的最终态语义，以及
//      路由表里「字面段必须排在 {id} 通配之前」这条只有运行期才暴露的顺序约束；
//   6. 端到端出声：合成一个真 WAV → 注册根目录 → 扫描 → 列出曲目 → load → play
//      → 收到 spectrum 事件。这是插件形态下唯一能证明「原生音频在 dbx 子进程里
//      真的出声」的检查，也是二进制信封（封面 base64 往返）的落点；
//   7. 歌单域：增删改名、曲目增删与排序（含成员校验）、在线曲目的虚拟 id 与元数据
//      快照、M3U 导出为裸 JSON 字符串并能原样导回。
//
// 用法：node scripts/check-plugin-sidecar.js
// 二进制默认找 target/debug/dbx-plugin-hertz[.exe]，可用 HERTZ_PLUGIN_BIN 覆盖。

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    failures.push(label);
    console.log('  FAIL ' + label);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label + (actual === expected ? '' : `（得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`));
}

function findBinary() {
  if (process.env.HERTZ_PLUGIN_BIN) return process.env.HERTZ_PLUGIN_BIN;
  const exe = process.platform === 'win32' ? 'dbx-plugin-hertz.exe' : 'dbx-plugin-hertz';
  const candidate = path.join(ROOT, 'target', 'debug', exe);
  return fs.existsSync(candidate) ? candidate : null;
}

/// 把一次请求写进 stdin，等对应的 id 回来。
/// 期间收到的通知（method 而无 id）交给 onNotify，事件转发链路要靠它验证。
function makeClient(child, timeoutMs) {
  let buffer = '';
  const pending = new Map();
  const notifications = [];
  const listeners = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failures.push('sidecar 写出了非 JSON 行（stdout 被日志污染？）：' + line.slice(0, 120));
        continue;
      }
      if (message.method !== undefined && message.id === undefined) {
        notifications.push(message);
        listeners.forEach((listener) => listener(message));
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  return {
    notifications,
    /// 订阅转发出来的服务端事件。返回退订函数。
    onNotify(listener) {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    send(method, params) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`等待 ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(payload + '\n');
      });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// 轮询到 probe 返回真为止。probe 自己把最后一次结果留在外面，超时了好打印诊断。
async function pollUntil(probe, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/// 等一条服务端事件（订阅以来已经收到的也算），超时给 null。
function waitForEvent(client, match, timeoutMs) {
  return new Promise((resolve) => {
    const seen = client.notifications.find(
      (n) => n.method === 'studio/event' && match(n.params || {}),
    );
    if (seen) {
      resolve(seen.params);
      return;
    }
    let timer = null;
    const off = client.onNotify((message) => {
      if (message.method !== 'studio/event') return;
      const params = message.params || {};
      if (!match(params)) return;
      clearTimeout(timer);
      off();
      resolve(params);
    });
    timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
  });
}

/// 合成一个带 RIFF INFO 标签的 16-bit 单声道 WAV。
///
/// 用真文件而不是喂假数据：扫描 → 解码 → 出声这条链上只有真音频才验得到。
/// 标题/艺术家特意写进文件标签，这样「扫描真的解析了元数据」才算被证明——
/// 退化成文件名（或整条链根本没跑）时这里会红，而不是悄悄通过。
function writeWav(file, options = {}) {
  const {
    seconds = 2,
    freq = 440,
    title = 'Sidecar Smoke Tone',
    artist = 'Hertz Studio',
  } = options;
  const rate = 44100;
  const frames = Math.round(rate * seconds);
  const samples = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767);
    samples.writeInt16LE(value, i * 2);
  }
  // RIFF 块长度是奇数时要补一个 pad 字节，否则后面的块全部错位。
  const chunk = (id, payload) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(payload.length, 4);
    const pad = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, payload, pad]);
  };
  // INFO 字符串按真实文件的形状写：以 NUL 结尾，且长度字段把终止符算在内——
  // ffmpeg 的 ff_riff_write_info_tag 正是这么干的（`len = strlen + 1`，奇数再补
  // pad）。symphonia 0.5.5 的 riff::parse 不剥这个终止符，所以标题曾经带着
  // "\u0000" 一路落库；vmusic-library 现在在边界上剥掉了。这里坚持喂"脏"输入，
  // 就是为了盯着扫描 → 入库 → API 这一整条路别退化。
  const text = (id, value) => chunk(id, Buffer.concat([Buffer.from(value, 'ascii'), Buffer.alloc(1)]));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);          // PCM
  fmt.writeUInt16LE(1, 2);          // 单声道
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8);   // 字节率
  fmt.writeUInt16LE(2, 12);         // 块对齐
  fmt.writeUInt16LE(16, 14);        // 位深
  const info = Buffer.concat([
    Buffer.from('INFO', 'ascii'),
    text('INAM', title),
    text('IART', artist),
  ]);
  const payload = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    chunk('LIST', info),
    chunk('data', samples),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length, 4);
  fs.writeFileSync(file, Buffer.concat([riff, payload]));
}

async function main() {
  const binary = findBinary();
  if (!binary) {
    console.error('找不到 sidecar 二进制。先跑：cargo build -p dbx-plugin-hertz');
    console.error('或用 HERTZ_PLUGIN_BIN 指定路径。');
    process.exit(2);
  }

  // 专属临时数据目录：绝不碰真实曲库，也不会和 7634 上常驻的独立实例抢 SQLite。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-plugin-check-'));
  const child = spawn(binary, [], {
    env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir, VMUSIC_LOG: 'warn' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stderr 只收集不打印：sidecar 的日志必须走 stderr，stdout 是协议信道。
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const client = makeClient(child, 30000);
  let exitCode = 1;
  // 端到端那一段要一个真目录放合成的 WAV，与数据目录分开清理。
  let musicDir = null;

  try {
    console.log('\n握手');
    const init = await client.send('plugin/initialize', {
      host: { hostApiVersion: '1.4.0', protocolVersions: [1], features: [] },
    });
    ok(init.result !== undefined, 'plugin/initialize 返回 result 而不是 error');
    eq(init.result && init.result.protocolVersion, 1, '协商出的协议版本是 1');
    ok(
      init.result && init.result.plugin && typeof init.result.plugin.id === 'string',
      '握手回报了插件 id：' + (init.result && init.result.plugin ? init.result.plugin.id : '(无)'),
    );

    console.log('\n事件订阅');
    const subscribed = await client.send('studio/events/subscribe', {});
    eq(subscribed.result && subscribed.result.status, 200, '订阅返回 200 信封');
    // 事件泵每 20ms 推一次快照，所以订阅后很快应该能收到 state 事件。
    // 收不到说明转发器没起来——而转发器只能在 handle() 里惰性启动，这条正是它的回归。
    const sawState = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      const seen = client.notifications.some(
        (n) => n.method === 'studio/event' && n.params && n.params.type === 'state',
      );
      if (seen) {
        clearTimeout(timer);
        resolve(true);
        return;
      }
      client.onNotify((message) => {
        if (message.method === 'studio/event' && message.params && message.params.type === 'state') {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    ok(sawState, '订阅后收到 studio/event 的 state 事件（转发链路通）');

    console.log('\n门面信封');
    const health = await client.send('v1/health', { op: 'GET' });
    eq(health.result && health.result.status, 200, 'v1/health 返回 200 信封');
    const healthBody = (health.result && health.result.body) || {};
    eq(healthBody.status, 'ok', 'health.status === ok');
    eq(healthBody.host, 'dbx', 'health.host 标出插件形态');
    ok(typeof healthBody.version === 'string' && healthBody.version.length > 0, 'health.version 有值');
    ok(
      typeof healthBody.backend === 'string' && healthBody.backend.length > 0,
      'health.backend 有值：' + healthBody.backend,
    );

    const state = await client.send('v1/state', { op: 'GET' });
    eq(state.result && state.result.status, 200, 'v1/state 返回 200 信封');
    const stateBody = (state.result && state.result.body) || {};
    ok('playing' in stateBody, 'state 带 playing 字段');
    ok('position_ms' in stateBody, 'state 带 position_ms 字段');
    // buffering 是 HTTP 版在快照之外叠加的覆盖态，插件形态必须同口径。
    ok('buffering' in stateBody, 'state 叠加了 buffering 覆盖态');

    console.log('\n错误契约');
    const missing = await client.send('v1/nope/not-a-method', { op: 'GET' });
    // 路由表没登记的 path 走 not_found；重点是错误体的**形状**。
    ok(missing.result !== undefined, '未知方法走带内信封而不是 JSON-RPC error');
    eq(missing.result && missing.result.status, 404, '未实现的 path 返回 404');
    const detail = ((missing.result || {}).body || {}).error || {};
    eq(typeof detail.code, 'string', 'error.code 是字符串');
    ok(typeof detail.message === 'string' && detail.message.length > 0, 'error.message 有值');
    ok(
      typeof detail.request_id === 'string' && detail.request_id.length > 0,
      'error.request_id 是 snake_case 且有值（前端契约字段名）',
    );
    ok(!('requestId' in detail), 'error 里没有误写成 requestId 的驼峰字段');
    ok(!('source' in detail), '本地接口的错误不带 source 字段');

    // 域内 404（查无此曲）与协议级 404（无此方法）形状必须一致：前端只认
    // error.code，不会去区分这个 404 是哪一层给的。
    const noTrack = await client.send('v1/tracks/does-not-exist', { op: 'GET' });
    eq(noTrack.result && noTrack.result.status, 404, '查无此曲 → 404');
    eq(((noTrack.result || {}).body || {}).error?.code, 'not_found', '查无此曲的 code 是 not_found');

    console.log('\n播放域');
    const queue = await client.send('v1/player/queue', { op: 'GET' });
    eq(queue.result && queue.result.status, 200, 'GET v1/player/queue → 200');
    ok(Array.isArray((queue.result || {}).body?.queue), 'queue 是数组');

    const dsp = await client.send('v1/player/dsp', { op: 'GET' });
    eq(dsp.result && dsp.result.status, 200, 'GET v1/player/dsp → 200');
    const eq6 = (dsp.result || {}).body?.eq_gains_db;
    ok(Array.isArray(eq6) && eq6.length === 6, 'dsp 带 6 段 EQ 增益');

    const devices = await client.send('v1/devices', { op: 'GET' });
    eq(devices.result && devices.result.status, 200, 'GET v1/devices → 200');
    ok(Array.isArray((devices.result || {}).body?.devices), 'devices 是数组');

    // 音量：合法值要能读回来，越界要 400 而不是被静默夹住——夹住的话
    // 界面滑杆会显示一个和后端不一致的值。
    const setVolume = await client.send('v1/player/volume', { op: 'POST', body: { volume: 0.42 } });
    eq(setVolume.result && setVolume.result.status, 200, 'POST volume 0.42 → 200');
    const gotVolume = (setVolume.result || {}).body?.volume;
    ok(Math.abs(gotVolume - 0.42) < 0.01, 'volume 回读约等于 0.42（得到 ' + gotVolume + '）');
    const badVolume = await client.send('v1/player/volume', { op: 'POST', body: { volume: 1.5 } });
    eq(badVolume.result && badVolume.result.status, 400, 'volume 越界 → 400');
    eq(((badVolume.result || {}).body || {}).error?.code, 'bad_request', '越界的 code 是 bad_request');

    const setMode = await client.send('v1/player/mode', { op: 'POST', body: { mode: 'shuffle' } });
    eq(setMode.result && setMode.result.status, 200, 'POST mode shuffle → 200');
    eq((setMode.result || {}).body?.mode, 'shuffle', 'mode 回读为 shuffle');

    // 动词映射：/v1/player/queue 是 GET|PUT。动词错了必须 404，
    // 不能静默落到 GET 上——那会让"保存队列"看起来成功其实没保存。
    const wrongVerb = await client.send('v1/player/queue', { op: 'POST', body: { queue: [] } });
    eq(wrongVerb.result && wrongVerb.result.status, 404, 'POST v1/player/queue → 404（该路径只有 GET|PUT）');

    const putQueue = await client.send('v1/player/queue', { op: 'PUT', body: { queue: ['a', 'b'], index: 1 } });
    eq(putQueue.result && putQueue.result.status, 200, 'PUT v1/player/queue → 200');
    eq((putQueue.result || {}).body?.index, 1, 'PUT queue 回读 index');

    // 空库上直接 play 不该把 sidecar 打崩：之后还要能继续应答。
    await client.send('v1/player/play', { op: 'POST' });
    const alive = await client.send('v1/health', { op: 'GET' });
    eq(alive.result && alive.result.status, 200, '空队列 play 之后 sidecar 仍在应答');

    // 节拍图三态：库里查无此曲应给 404 + {status:"unavailable"}，
    // 而不是标准 {error} 体——前端按 body.status 分流、不弹错。
    const beatmap = await client.send('v1/stage/beatmap', { op: 'GET', query: { track: 'nope' } });
    const beatStatus = (beatmap.result || {}).status;
    ok([200, 202, 404].includes(beatStatus), 'beatmap 落在三态之一：' + beatStatus);
    if (beatStatus === 404) {
      eq((beatmap.result || {}).body?.status, 'unavailable', '404 体是 {status:"unavailable"} 而非 {error}');
      ok(!('error' in ((beatmap.result || {}).body || {})), '404 体里没有 error 字段');
    }

    console.log('\n曲库域：空库契约');
    // 路由表的顺序约束：slice pattern 只按书写顺序取第一个匹配，而
    // `["v1","tracks",id]` 同样能匹配 /v1/tracks/ids。字面段排到通配后面，这里
    // 就会变成「查无此曲 ids」而不是 id 列表——axum 会自动按静态段优先排序，
    // 这一层不会，所以必须有检查盯着。
    const ids = await client.send('v1/tracks/ids', { op: 'GET' });
    eq(ids.result && ids.result.status, 200, 'GET v1/tracks/ids → 200（字面段没被 {id} 通配吃掉）');
    ok(Array.isArray((ids.result || {}).body?.track_ids), 'tracks/ids 回的是 track_ids 数组');

    const facets = await client.send('v1/tracks/facets', { op: 'GET', query: { kind: 'album' } });
    eq(facets.result && facets.result.status, 200, 'GET v1/tracks/facets → 200');
    eq((facets.result || {}).body?.kind, 'album', 'facets 回显 kind');

    const emptyTracks = await client.send('v1/tracks', { op: 'GET' });
    eq(emptyTracks.result && emptyTracks.result.status, 200, 'GET v1/tracks → 200');
    eq((emptyTracks.result || {}).body?.total, 0, '空库 total 为 0');

    // 排序非法要 400：静默按默认排序返回的话，界面下拉框会和列表内容不一致。
    const badSort = await client.send('v1/tracks', { op: 'GET', query: { sort: 'nope' } });
    eq(badSort.result && badSort.result.status, 400, 'sort 非法 → 400');

    // 分页参数是字符串（URLSearchParams 的产物）也得认。用 serde_json 直接反序列化
    // 请求结构体的话，这里会 400 而独立形态正常——两个宿主行为就此分叉。
    const paged = await client.send('v1/tracks', { op: 'GET', query: { limit: '50', offset: '0' } });
    eq(paged.result && paged.result.status, 200, 'limit/offset 传字符串 → 200（与 axum Query<T> 同口径）');

    const emptyBatch = await client.send('v1/tracks/batch-edit', { op: 'POST', body: { track_ids: [] } });
    eq(emptyBatch.result && emptyBatch.result.status, 400, 'batch-edit 空 track_ids → 400');

    const noCover = await client.send('v1/tracks/whatever/cover', { op: 'GET' });
    eq(noCover.result && noCover.result.status, 204, '没有封面 → 204');
    ok(
      (noCover.result || {}).body === null || (noCover.result || {}).body === undefined,
      '204 的体是 null（前端按「无封面」处理，不会让整行渲染失败）',
    );

    const missingTracks = await client.send('v1/tracks/missing', { op: 'GET' });
    eq(missingTracks.result && missingTracks.result.status, 200, 'GET v1/tracks/missing → 200');
    eq(((missingTracks.result || {}).body?.missing || []).length, 0, '空库上没有失效曲目');

    console.log('\n扫描根目录与设置');
    const roots = await client.send('v1/library/roots', { op: 'GET' });
    eq(roots.result && roots.result.status, 200, 'GET v1/library/roots → 200');
    ok(Array.isArray((roots.result || {}).body?.roots), 'roots 是数组');

    const badRoot = await client.send('v1/library/roots', {
      op: 'POST',
      body: { path: path.join(os.tmpdir(), 'hertz-check-不存在的目录') },
    });
    eq(badRoot.result && badRoot.result.status, 400, '添加不存在的根目录 → 400');

    const idle = await client.send('v1/library/status', { op: 'GET' });
    eq(idle.result && idle.result.status, 200, 'GET v1/library/status → 200');
    eq((idle.result || {}).body?.running, false, '没扫过的时候 running=false');

    const settings = await client.send('v1/settings', { op: 'GET' });
    eq(settings.result && settings.result.status, 200, 'GET v1/settings → 200');
    ok(
      !Object.keys((settings.result || {}).body || {}).some(
        (key) => key.startsWith('online_cred_') || key.startsWith('online_cookie_'),
      ),
      'settings 不外泄音源凭据键',
    );
    const putSettings = await client.send('v1/settings', { op: 'PUT', body: { smoke_marker: 'phase3' } });
    eq(putSettings.result && putSettings.result.status, 200, 'PUT v1/settings → 200');
    const readBack = await client.send('v1/settings', { op: 'GET' });
    eq((readBack.result || {}).body?.smoke_marker, 'phase3', '写进去的设置能读回');
    // 凭据只能走 /v1/online/cookie（那里才校验得了音源是否真支持登录）。这条策略
    // 两个宿主共用 is_credential；插件形态漏掉就等于开了个绕过校验的写入口。
    const credWrite = await client.send('v1/settings', {
      op: 'PUT',
      body: { online_cred_netease: { cookie: 'x' } },
    });
    eq(credWrite.result && credWrite.result.status, 400, 'PUT settings 写凭据键 → 400');

    console.log('\n收藏与历史');
    const favorites = await client.send('v1/favorites', { op: 'GET' });
    eq(favorites.result && favorites.result.status, 200, 'GET v1/favorites → 200');
    const favBody = (favorites.result || {}).body || {};
    ok(Array.isArray(favBody.favorites), 'favorites 是数组');
    // counts 是给前端两个 tab 一次拿齐的，缺了就要多请求一轮。
    eq(favBody.counts && favBody.counts.track, 0, 'counts.track 为 0');
    eq(favBody.counts && favBody.counts.radio, 0, 'counts.radio 为 0');

    const badKind = await client.send('v1/favorites', { op: 'GET', query: { kind: 'nope' } });
    eq(badKind.result && badKind.result.status, 400, 'kind 非法 → 400');

    const emptyMembership = await client.send('v1/favorites/membership', {
      op: 'POST',
      body: { kind: 'track', source: 'local', ids: [] },
    });
    eq(emptyMembership.result && emptyMembership.result.status, 200, 'membership 空 ids → 200');
    eq(((emptyMembership.result || {}).body?.ids || []).length, 0, 'membership 空 ids 回空数组');

    const noRef = await client.send('v1/favorites/toggle', {
      op: 'POST',
      body: { kind: 'track', source: 'local' },
    });
    eq(noRef.result && noRef.result.status, 400, 'toggle 缺 ref_id → 400');

    const history = await client.send('v1/history', { op: 'GET' });
    eq(history.result && history.result.status, 200, 'GET v1/history → 200');
    ok(Array.isArray((history.result || {}).body?.items), 'history.items 是数组');

    // 路径参数不是整数要 400 而不是 404：给 404 的话前端按「这条已经不在了」
    // 静默处理，一个真实的参数错误就被咽下去了。
    const badHistoryId = await client.send('v1/history/abc', { op: 'DELETE' });
    eq(badHistoryId.result && badHistoryId.result.status, 400, 'DELETE v1/history/abc → 400（不是 404）');

    console.log('\n端到端：扫描 → 播放 → 频谱');
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-plugin-music-'));
    writeWav(path.join(musicDir, 'smoke-tone.wav'), { seconds: 6 });

    const addedRoot = await client.send('v1/library/roots', {
      op: 'POST',
      body: { path: musicDir, enabled: true },
    });
    eq(addedRoot.result && addedRoot.result.status, 200, 'POST v1/library/roots → 200');
    const rootList = (addedRoot.result || {}).body?.roots || [];
    eq(rootList.length, 1, '根目录回读为 1 条');
    const rootPath = rootList[0] && rootList[0].path;
    ok(typeof rootPath === 'string' && rootPath.length > 0, '根目录路径已归一化：' + rootPath);

    const scanned = await client.send('v1/library/scan', { op: 'POST', body: { root: rootPath } });
    eq(scanned.result && scanned.result.status, 200, 'POST v1/library/scan → 200');
    eq((scanned.result || {}).body?.started, true, 'scan 回 started:true');

    // 扫描是后台任务。一个文件通常几十毫秒就完，但解码 + 写库给足余量。
    let scanBody = {};
    const scanDone = await pollUntil(async () => {
      const status = await client.send('v1/library/status', { op: 'GET' });
      scanBody = (status.result || {}).body || {};
      return scanBody.running === false && scanBody.total > 0;
    }, 60000);
    ok(
      scanDone,
      '扫描收尾（running=false 且 total>0）' + (scanDone ? '' : '：' + JSON.stringify(scanBody).slice(0, 400)),
    );
    ok(scanBody.added >= 1, '扫出至少 1 首（added=' + scanBody.added + '）');
    eq(scanBody.failed, 0, '没有解码失败的文件');

    const tracks = await client.send('v1/tracks', { op: 'GET', query: { limit: '10' } });
    const list = (tracks.result || {}).body?.tracks || [];
    eq(list.length, 1, '曲目列表里恰好 1 首');
    const track = list[0] || {};
    // 必须是精确相等而不是「包含」：RIFF INFO 的 NUL 终止符曾经跟着落库，标题
    // 成了 "Sidecar Smoke Tone\u0000"——界面上看不出来，精确比对才抓得住。
    eq(track.title, 'Sidecar Smoke Tone', '标题来自文件标签，且没带着 RIFF INFO 的 NUL 终止符');
    eq(track.artist, 'Hertz Studio', '艺术家来自文件标签');
    ok(
      Math.abs((track.duration_ms || 0) - 6000) <= 250,
      '时长约 6000ms（得到 ' + track.duration_ms + '）',
    );

    const one = await client.send('v1/tracks/' + encodeURIComponent(track.id), { op: 'GET' });
    eq(one.result && one.result.status, 200, 'GET v1/tracks/{id} → 200');
    eq((one.result || {}).body?.id, track.id, '单曲读回的 id 与列表一致');

    const artistFacets = await client.send('v1/tracks/facets', { op: 'GET', query: { kind: 'artist' } });
    ok(
      ((artistFacets.result || {}).body?.facets || []).some(
        (facet) => facet.name === 'Hertz Studio' && facet.count === 1,
      ),
      'facets(artist) 里有扫出来的艺术家且计数为 1',
    );
    const idsAfter = await client.send('v1/tracks/ids', { op: 'GET' });
    eq(((idsAfter.result || {}).body?.track_ids || []).length, 1, 'tracks/ids 与列表同口径');

    console.log('\n二进制信封：封面往返');
    // 1x1 PNG。字节级比对：raw_base64 进、base64 出，编解码任一侧写错都会红。
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const coverPath = 'v1/tracks/' + encodeURIComponent(track.id) + '/cover';
    const putCover = await client.send(coverPath, {
      op: 'POST',
      raw_base64: png.toString('base64'),
      raw_content_type: 'image/png',
    });
    eq(putCover.result && putCover.result.status, 200, 'POST 封面（raw_base64）→ 200');
    eq((putCover.result || {}).body?.cover_key, track.id + '.png', 'cover_key 按 content-type 落成 .png');

    const gotCover = await client.send(coverPath, { op: 'GET' });
    eq(gotCover.result && gotCover.result.status, 200, 'GET 封面 → 200');
    eq((gotCover.result || {}).body?.content_type, 'image/png', '封面 content_type 回读为 image/png');
    ok(
      Buffer.from((gotCover.result || {}).body?.data || '', 'base64').equals(png),
      '封面字节原样往返（base64 编解码无损）',
    );
    const afterCover = await client.send('v1/tracks/' + encodeURIComponent(track.id), { op: 'GET' });
    eq(
      (afterCover.result || {}).body?.has_cover,
      true,
      '换封面后 has_cover 置真（前端据此才会去取图）',
    );

    // 非法 base64 是信封非法，走 JSON-RPC error 而不是带内 400：协议层的错
    // 不该被伪装成域错误，否则前端会当成「这张封面取不到」静默降级。
    const badBase64 = await client.send(coverPath, {
      op: 'POST',
      raw_base64: '***',
      raw_content_type: 'image/png',
    });
    ok(badBase64.error !== undefined, '非法 base64 → JSON-RPC error');
    eq(badBase64.error && badBase64.error.code, -32602, '非法 base64 的错误码是 -32602');

    console.log('\n歌词');
    const lyricsPath = 'v1/tracks/' + encodeURIComponent(track.id) + '/lyrics';
    const noLyrics = await client.send(lyricsPath, { op: 'GET' });
    eq(noLyrics.result && noLyrics.result.status, 200, 'GET lyrics → 200（无词也给 200 + 空文档）');
    eq(((noLyrics.result || {}).body?.lines || []).length, 0, '合成文件没有歌词');

    await client.send(lyricsPath, { op: 'PUT', body: { content: '[00:01.00]冒烟测试' } });
    const imported = await client.send(lyricsPath, { op: 'GET' });
    eq((imported.result || {}).body?.source, 'imported', '导入后 source=imported');
    eq((imported.result || {}).body?.lines?.[0]?.start_ms, 1000, '第一行时间戳 1000ms');

    // 偏移叠加：total = 文件 [offset:] + 用户偏移，读取端一次应用。
    await client.send(lyricsPath + '/offset', { op: 'PUT', body: { offset_ms: 500 } });
    const shifted = await client.send(lyricsPath, { op: 'GET' });
    eq((shifted.result || {}).body?.user_offset_ms, 500, 'user_offset_ms 回读 500');
    eq((shifted.result || {}).body?.lines?.[0]?.start_ms, 1500, '用户偏移叠加到行时间戳上（1000+500）');

    const blankLyrics = await client.send(lyricsPath, { op: 'PUT', body: { content: '   ' } });
    eq(blankLyrics.result && blankLyrics.result.status, 400, '导入空白歌词 → 400');

    await client.send(lyricsPath, { op: 'DELETE' });
    const cleared = await client.send(lyricsPath, { op: 'GET' });
    ok(
      (cleared.result || {}).body?.source !== 'imported',
      'DELETE 后不再是 imported（偏移一并清掉，回退到内嵌/sidecar）',
    );

    console.log('\n播放与频谱');
    // 音量压低：这一段会真的出声，而检查只需要频谱帧有能量，不需要响。
    // 频谱按帧峰值归一化，所以小声也照样有非零频段。
    await client.send('v1/player/volume', { op: 'POST', body: { volume: 0.1 } });
    const loaded = await client.send('v1/player/load', { op: 'POST', body: { track_id: track.id } });
    eq(loaded.result && loaded.result.status, 200, 'POST v1/player/load → 200');
    eq((loaded.result || {}).body?.track_id, track.id, 'load 后快照的 track_id 是刚扫出来的那首');

    const played = await client.send('v1/player/play', { op: 'POST' });
    eq(played.result && played.result.status, 200, 'POST v1/player/play → 200');
    eq((played.result || {}).body?.playing, true, 'play 之后快照 playing=true');

    const before = (((await client.send('v1/state', { op: 'GET' })).result || {}).body) || {};
    await sleep(700);
    const after = (((await client.send('v1/state', { op: 'GET' })).result || {}).body) || {};
    ok(
      (after.position_ms || 0) > (before.position_ms || 0),
      `position_ms 在前进（${before.position_ms} → ${after.position_ms}）`,
    );

    // 频谱是「真的在解码并输出音频」的唯一可观测证据：NullBackend 不产生频谱帧，
    // 解码停摆也不产生。收不到就说明这条链断了。
    if (healthBody.backend === 'null') {
      console.log('  --   backend=null，跳过频谱断言（NullBackend 不产生频谱帧）');
    } else {
      const spectrum = await waitForEvent(
        client,
        (params) => params.type === 'spectrum' && Array.isArray(params.bands),
        15000,
      );
      ok(spectrum, '收到 spectrum 事件（音频在插件子进程里真的出声了）');
      ok(spectrum && spectrum.bands.length > 0, 'spectrum.bands 非空');
      ok(
        spectrum && spectrum.bands.some((value) => value > 0),
        'spectrum 至少一个频段有能量',
      );
    }

    // 播放提交时写历史：这条把播放域与历史域串起来验。
    const playedHistory = await client.send('v1/history', { op: 'GET', query: { limit: '10' } });
    const items = (playedHistory.result || {}).body?.items || [];
    ok(items.length >= 1, '播放后历史里有记录');
    ok(
      items.some((item) => item.title === 'Sidecar Smoke Tone'),
      '历史记录带的是曲名而不是 id（元数据没有退化）',
    );

    // 收藏本地曲目时前端往往只持有 id：标题由服务端回读本地库补上。回读是尽力
    // 而为而不是前置条件，所以这里既验「补上了」也验「补不上时不判死」。
    const favOn = await client.send('v1/favorites/toggle', {
      op: 'POST',
      body: { kind: 'track', source: 'local', ref_id: track.id },
    });
    eq((favOn.result || {}).body?.favorited, true, 'toggle → favorited=true');
    eq(
      (favOn.result || {}).body?.favorite?.title,
      'Sidecar Smoke Tone',
      '收藏标题由服务端回读本地库补上',
    );

    const membership = await client.send('v1/favorites/membership', {
      op: 'POST',
      body: { kind: 'track', source: 'local', ids: [track.id, 'not-favorited'] },
    });
    eq(((membership.result || {}).body?.ids || []).length, 1, 'membership 只回命中的那个 id');

    const favOff = await client.send('v1/favorites/toggle', {
      op: 'POST',
      body: { kind: 'track', source: 'local', ref_id: track.id },
    });
    eq(
      (favOff.result || {}).body?.favorited,
      false,
      '再 toggle → favorited=false（返回最终态而非「操作成功」）',
    );

    await client.send('v1/player/pause', { op: 'POST' });

    console.log('\n歌单域');
    const created = await client.send('v1/playlists', { op: 'POST', body: { name: '冒烟歌单' } });
    eq(created.result && created.result.status, 200, 'POST v1/playlists → 200');
    // HTTP 版直接回 Playlist 对象本身、不包一层，插件形态必须同形——包了的话
    // 前端 createPlaylist() 拿到的是 {playlist:{…}}，id 读不出来。
    const pl = (created.result || {}).body || {};
    const plPath = 'v1/playlists/' + encodeURIComponent(pl.id || 'missing');
    ok(typeof pl.id === 'string' && pl.id.length > 0, '新建直接回 Playlist 对象（不包一层）');
    eq(pl.name, '冒烟歌单', '歌单名回读一致');

    const blankName = await client.send('v1/playlists', { op: 'POST', body: { name: '   ' } });
    eq(blankName.result && blankName.result.status, 400, '空白歌单名 → 400');

    const listedPl = await client.send('v1/playlists', { op: 'GET' });
    eq(((listedPl.result || {}).body?.playlists || []).length, 1, 'GET v1/playlists 回 1 条');

    const addedTracks = await client.send(plPath + '/tracks', {
      op: 'POST',
      body: { track_ids: [track.id] },
    });
    eq(addedTracks.result && addedTracks.result.status, 200, 'POST 加入本地曲目 → 200');

    const emptyAdd = await client.send(plPath + '/tracks', { op: 'POST', body: { track_ids: [] } });
    eq(emptyAdd.result && emptyAdd.result.status, 400, '空 track_ids → 400');

    const contents = await client.send(plPath + '/tracks', { op: 'GET' });
    eq(((contents.result || {}).body?.track_ids || []).length, 1, '曲目读回 1 条');
    // 本地 id 走 tracks 表的实时字段，所以这里应当是扫出来的真标题——歌单里存的
    // 是 id 而不是快照，改标签之后歌单要跟着变。
    eq(
      (contents.result || {}).body?.tracks?.[0]?.title,
      'Sidecar Smoke Tone',
      '本地曲目从 tracks 表实时解析（不是入单时的快照）',
    );

    // 在线曲目的身份协议：客户端传平台 id + source，服务端拼虚拟 id 并落快照。
    const onlineAdd = await client.send(plPath + '/tracks', {
      op: 'POST',
      body: {
        tracks: [{ id: 'song-123', source: 'netease', title: '在线曲', artist: '某人', duration_ms: 200000 }],
      },
    });
    eq(onlineAdd.result && onlineAdd.result.status, 200, 'POST 加入在线曲目 → 200');
    const mixed = await client.send(plPath + '/tracks', { op: 'GET' });
    const mixedIds = (mixed.result || {}).body?.track_ids || [];
    eq(mixedIds.length, 2, '歌单里现在有 2 条');
    eq(mixedIds[1], 'online:netease:song-123', '在线条目被拼成虚拟 id');
    eq((mixed.result || {}).body?.tracks?.[1]?.title, '在线曲', '在线条目回读入单时的快照');

    // 没有任何元数据的在线条目存了也无法渲染：必须拒绝，不能存一条空快照进去。
    const bareOnline = await client.send(plPath + '/tracks', {
      op: 'POST',
      body: { tracks: [{ id: 'x', source: 'netease' }] },
    });
    eq(bareOnline.result && bareOnline.result.status, 400, '在线曲目缺元数据 → 400');

    const reordered = await client.send(plPath + '/tracks/order', {
      op: 'PUT',
      body: { track_ids: [mixedIds[1], mixedIds[0]] },
    });
    eq(reordered.result && reordered.result.status, 200, 'PUT 重排 → 200');
    const afterReorder = await client.send(plPath + '/tracks', { op: 'GET' });
    eq((afterReorder.result || {}).body?.track_ids?.[0], mixedIds[1], '重排后顺序确实换了');

    // 提交的 id 必须正好是当下成员的一个排列。少一个就报错，而不是静默把歌单
    // 截断成一条——那等于一次没人同意的成员变更。
    const badReorder = await client.send(plPath + '/tracks/order', {
      op: 'PUT',
      body: { track_ids: [mixedIds[0]] },
    });
    const badStatus = (badReorder.result || {}).status;
    ok(badStatus >= 400, '成员不匹配的重排 → 4xx/5xx（得到 ' + badStatus + '），不是静默成功');
    const afterBadReorder = await client.send(plPath + '/tracks', { op: 'GET' });
    eq(
      ((afterBadReorder.result || {}).body?.track_ids || []).length,
      2,
      '被拒绝的重排没有改动成员数',
    );

    // M3U 导出：HTTP 版是 audio/x-mpegurl 纯文本 + 附件下载，信封装不下，所以体是
    // 一个裸 JSON 字符串——前端 `typeof text === 'string'` 就是按这个契约写的。
    const m3u = await client.send(plPath + '/m3u', { op: 'GET' });
    eq(m3u.result && m3u.result.status, 200, 'GET m3u → 200');
    const m3uText = (m3u.result || {}).body;
    eq(typeof m3uText, 'string', 'm3u 体是裸 JSON 字符串（不是对象）');
    ok(typeof m3uText === 'string' && m3uText.startsWith('#EXTM3U'), 'm3u 以 #EXTM3U 开头');
    ok(
      typeof m3uText === 'string' && m3uText.includes('smoke-tone.wav'),
      'm3u 里有本地曲目的路径（在线曲无本地路径，不输出）',
    );

    const missingM3u = await client.send('v1/playlists/nope/m3u', { op: 'GET' });
    eq(missingM3u.result && missingM3u.result.status, 404, '不存在的歌单导出 → 404');

    // 导入回环：把刚导出的文本导回去，应当新建歌单并按路径命中同一首本地曲。
    const importedPl = await client.send('v1/playlists/import-m3u', {
      op: 'POST',
      body: { name: '导入的歌单', content: typeof m3uText === 'string' ? m3uText : '' },
    });
    eq(importedPl.result && importedPl.result.status, 200, 'POST import-m3u → 200');
    eq((importedPl.result || {}).body?.added, 1, '导入按路径命中 1 首本地曲');
    eq((importedPl.result || {}).body?.skipped, 0, '没有未命中的行');

    const notM3u = await client.send('v1/playlists/import-m3u', {
      op: 'POST',
      body: { name: 'x', content: '这不是播放列表' },
    });
    eq(notM3u.result && notM3u.result.status, 400, '非 M3U 内容 → 400');

    const removedTrack = await client.send(
      plPath + '/tracks/' + encodeURIComponent(mixedIds[0]),
      { op: 'DELETE' },
    );
    eq(removedTrack.result && removedTrack.result.status, 200, 'DELETE 单曲 → 200');
    const afterTrackRemove = await client.send(plPath + '/tracks', { op: 'GET' });
    eq(((afterTrackRemove.result || {}).body?.track_ids || []).length, 1, '移除后剩 1 条');

    const renamed = await client.send(plPath, { op: 'PUT', body: { name: '改过名的歌单' } });
    eq(renamed.result && renamed.result.status, 200, 'PUT 改名 → 200');
    const afterRename = await client.send('v1/playlists', { op: 'GET' });
    ok(
      ((afterRename.result || {}).body?.playlists || []).some(
        (p) => p.id === pl.id && p.name === '改过名的歌单',
      ),
      '改名后列表里是新名字',
    );

    // GET /v1/playlists/{id} 在 HTTP 版是 noop（axum 的 PUT|DELETE 组合要挂一个 GET），
    // 照搬过来保持路由表一一对应，也给前端留一条不会 404 的探测路径。
    const noopGet = await client.send(plPath, { op: 'GET' });
    eq(noopGet.result && noopGet.result.status, 200, 'GET /v1/playlists/{id} 的 noop → 200');

    const deletedPl = await client.send(plPath, { op: 'DELETE' });
    eq(deletedPl.result && deletedPl.result.status, 200, 'DELETE 歌单 → 200');
    const importedId = (importedPl.result || {}).body?.playlist_id;
    await client.send('v1/playlists/' + encodeURIComponent(importedId), { op: 'DELETE' });
    const finalPlaylists = await client.send('v1/playlists', { op: 'GET' });
    eq(((finalPlaylists.result || {}).body?.playlists || []).length, 0, '两个歌单都删干净了');

    // DELETE 的入参在 query 上：漏了 query 通道的话这里会删不掉。
    const removedRoot = await client.send('v1/library/roots', { op: 'DELETE', query: { path: rootPath } });
    eq(removedRoot.result && removedRoot.result.status, 200, 'DELETE v1/library/roots?path=… → 200');
    eq(((removedRoot.result || {}).body?.roots || []).length, 0, '删除后根目录为 0 条');

    // 删根目录不删曲目：库里的曲目还在，只是不再被扫描维护。
    const afterRemove = await client.send('v1/tracks', { op: 'GET' });
    eq((afterRemove.result || {}).body?.total, 1, '删根目录后曲目仍在库里');

    const deleted = await client.send('v1/tracks/batch-delete', {
      op: 'POST',
      body: { track_ids: [track.id] },
    });
    eq((deleted.result || {}).body?.deleted, 1, 'batch-delete 删掉 1 首');
    const afterDelete = await client.send('v1/tracks', { op: 'GET' });
    eq((afterDelete.result || {}).body?.total, 0, '删除后库为空');
    const coverGone = await client.send(coverPath, { op: 'GET' });
    eq(coverGone.result && coverGone.result.status, 204, '曲目删掉后封面缓存文件也清掉了（204）');

    console.log('\n信封校验');
    const badOp = await client.send('v1/health', { op: 'PATCH' });
    ok(badOp.error !== undefined, '非法 op 返回真正的 JSON-RPC error（协议级错误）');
    eq(badOp.error && badOp.error.code, -32602, '非法 op 的错误码是 -32602');

    console.log('\nstdout 纯净度');
    ok(
      !stderr.join('').includes('__VMUSIC'),
      'sidecar 启动没有异常输出',
    );

    exitCode = failures.length === 0 ? 0 : 1;
  } catch (error) {
    console.error('\n检查中断：' + error.message);
    if (stderr.length) console.error('--- sidecar stderr ---\n' + stderr.join('').slice(-2000));
    exitCode = 1;
  } finally {
    child.kill();
    // 临时数据目录里是 SQLite + WAL，Windows 下要等子进程真的退出才能删。
    setTimeout(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (musicDir) fs.rmSync(musicDir, { recursive: true, force: true });
    }, 500);
  }

  console.log('\n' + '─'.repeat(56));
  if (failures.length === 0) {
    console.log(`插件 sidecar 协议检查：${passed}/${passed} 全部通过`);
  } else {
    console.log(`插件 sidecar 协议检查：${passed} 通过 / ${failures.length} 失败`);
    failures.forEach((label) => console.log('  - ' + label));
  }
  process.exit(exitCode);
}

main();
