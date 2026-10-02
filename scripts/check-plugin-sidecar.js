#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// DBX 插件 sidecar 的协议冒烟检查（零依赖）。
//
// 真的把 dbx-plugin-hertz 起起来，用 stdio 喂 JSON-RPC，验证四件事：
//   1. plugin/initialize 握手能过（协议版本协商）；
//   2. 装配链路能跑通——数据目录、SQLite 迁移、音频后端（拿不到设备会回落 null）；
//   3. 门面信封 {status, body} 与 HTTP 版同构；
//   4. 错误体字段名是 request_id（snake_case）而不是 requestId。前端 app.js 的
//      错误归一化直接读这个字段，写错了整条错误链路会静默退化成"没有 request_id"。
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
    /// 订阅转发出来的服务端事件。
    onNotify(listener) {
      listeners.push(listener);
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
    const missing = await client.send('v1/tracks/does-not-exist', { op: 'GET' });
    // 路由表还没铺开的阶段，未实现的 path 一律 404；重点是错误体的**形状**。
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
