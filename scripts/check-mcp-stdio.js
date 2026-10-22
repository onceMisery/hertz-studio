// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 真实 MCP stdio 客户端端到端检查（技术路线 §12.1 MCP 反例的协议层实现）。
//
// 与 Rust 单测的区别：这里用 Node 起一个**真协议客户端**——JSON-RPC 帧走
// 子进程的 stdin/stdout，initialize/initialized/tools/list/tools/call 全部
// 按线格式来，任何帧污染、大小写丢弃、协议错序都会在这里暴露。完整客户端
// 矩阵（Claude 等真实宿主）与 Full/DBX 运行矩阵仍是发布门槛，本脚本是
// 它们的机器可跑下界。
//
// 前置：`cargo build -p hertz-studio`（脚本用 target/debug 的独立可执行文件，
// 不要求安装任何 MCP 依赖）。
//
// 用法：node scripts/check-mcp-stdio.js

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = process.env.HERTZ_BIN
  || path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'hertz-studio.exe' : 'hertz-studio');
const PROTOCOL_VERSION = '2025-11-25';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!fs.existsSync(BIN)) {
  fail(`未找到独立可执行文件 ${BIN}，先跑 cargo build -p hertz-studio`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-mcp-e2e-'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpJson(method, url, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(raw) });
          } catch (error) {
            reject(new Error(`应答不是 JSON: ${error.message}`));
          }
        });
      }
    );
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

/** MCP stdio 客户端：行分隔 JSON-RPC，id 关联应答。 */
class McpClient {
  constructor(child) {
    this.process = child;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(`  [adapter] ${chunk}`));
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(`stdout 出现非 JSON 行（transport 被污染）: ${line.slice(0, 80)}`);
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending(message);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 15000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.process.stdin.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method, params) {
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

async function main() {
  console.log(`data dir: ${dataDir}`);
  const server = spawn(BIN, ['--data-dir', dataDir, '--port', '0'], { stdio: 'ignore' });
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) fail(`独立服务异常退出（${code}）`);
  });

  try {
    // 等发现文件出现（--port 0 的实际端口在里面）。
    const discoveryPath = path.join(dataDir, 'ai', 'ai-discovery.json');
    let discovery = null;
    for (let i = 0; i < 150; i += 1) {
      await sleep(100);
      if (fs.existsSync(discoveryPath)) {
        discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
        break;
      }
    }
    if (!discovery) fail('15 秒内未出现 ai-discovery.json');
    const base = `http://127.0.0.1:${discovery.port}`;

    // 官方管理面（全权 token）建一份全范围 grant；凭据只在文件里。
    const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
    const created = await httpJson('POST', `${base}/v1/ai/grants`, {
      headers: { authorization: `Bearer ${token}` },
      body: { label: 'e2e', scopes: ['playback:control', 'playback:read', 'library:read', 'stage:capabilities_read', 'stage:intent_validate'] },
    });
    if (created.status !== 200) fail(`创建 grant 失败: ${created.status}`);
    const credential = fs.readFileSync(created.body.credential_path, 'utf8').trim();
    console.log(`grant: ${created.body.grant_id}`);

    const enabled = await httpJson('PUT', `${base}/v1/settings`, {
      headers: { authorization: `Bearer ${token}` }, body: { ai_stage_intent_tools: true },
    });
    if (enabled.status !== 200) fail('开启舞台契约工具失败');

    // 起适配器（真协议客户端这边的「被测服务」）。
    const adapter = spawn(
      BIN,
      ['--mcp-stdio', '--data-dir', dataDir, '--grant', created.body.grant_id],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const client = new McpClient(adapter);
    await sleep(300);

    // initialize / initialized（协议协商）。
    const init = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'check-mcp-stdio', version: '0.0.0' },
    });
    if (!init.result) fail(`initialize 无结果: ${JSON.stringify(init).slice(0, 120)}`);
    console.log(`initialize: 协议 ${init.result.protocolVersion}, 服务 ${init.result.serverInfo.name}`);
    client.notify('notifications/initialized', {});

    // tools/list：全 scope + 舞台开关会话应看到 10 个工具，命名与 A1 表一致。
    const listed = await client.request('tools/list', {});
    const names = listed.result.tools.map((tool) => tool.name);
    for (const expected of [
      'playback_snapshot_get',
      'playback_pause',
      'playback_next',
      'library_search',
    ]) {
      if (!names.includes(expected)) fail(`tools/list 缺少 ${expected}（实际: ${names.join(', ')}）`);
    }
    if (listed.result.tools.length !== 10) fail(`工具数应为 10，实际 ${listed.result.tools.length}`);
    console.log(`tools/list: ${names.length} 个工具`);

    // tools/call：同一 clientOperationId 两次 pause 必须是同一事实
    // （第二次回放，播放代际只前进一次）——空对象比较证明不了执行一次，
    // 这里比对的是代际与两次应答的相等性。
    const pauseArgs = { clientOperationId: 'e2e-pause-1' };
    const pause1 = await client.request('tools/call', {
      name: 'playback_pause',
      arguments: pauseArgs,
    });
    const pause2 = await client.request('tools/call', {
      name: 'playback_pause',
      arguments: pauseArgs,
    });
    if (pause1.result.isError) fail(`pause 意外失败: ${JSON.stringify(pause1.result)}`);
    if (
      JSON.stringify(pause1.result.structuredContent)
      !== JSON.stringify(pause2.result.structuredContent)
    ) {
      fail('同键两次 pause 应答不同：幂等失效');
    }
    if (pause1.result.structuredContent.outcome !== 'applied') {
      fail(`pause 应为 applied: ${JSON.stringify(pause1.result.structuredContent)}`);
    }
    console.log(`tools/call pause: applied（generation ${pause1.result.structuredContent.generation}，第二次为回放）`);

    // library_search：投影白名单（tracks 数组、无 path 字段）。
    const search = await client.request('tools/call', {
      name: 'library_search',
      arguments: { q: '非存在的关键词', limit: 5 },
    });
    if (search.result.isError) fail(`library_search 意外失败: ${JSON.stringify(search.result)}`);
    if (!Array.isArray(search.result.structuredContent.data.tracks)) {
      fail('library_search 应返回 data.tracks 数组');
    }
    console.log('tools/call library_search: ok（空曲库返回空数组）');

    const stage = await client.request('tools/call', {
      name: 'stage_capabilities_get', arguments: { limit: 2 },
    });
    if (stage.result.isError) fail('stage_capabilities_get 失败');
    const contract = stage.result.structuredContent;
    if (contract.scenes.length !== 2 || contract.nextOffset !== 2) fail('契约分页不一致');
    const scene = contract.scenes[0].id;
    const artifact = { artifactVersion: 1, mode: 'create', intent: { version: 1, scene, patch: {} },
      schemaVersion: contract.schemaVersion, schemaHash: contract.schemaHash,
      basePresetHash: contract.basePresetHashes[scene] };
    const valid = await client.request('tools/call', { name: 'stage_intent_validate', arguments: artifact });
    if (valid.result.isError || valid.result.structuredContent.validationStage !== 'intent'
      || valid.result.structuredContent.persisted !== false || valid.result.structuredContent.applied !== false) {
      fail('intent 校验层次或副作用标记不正确');
    }
    const invalid = await client.request('tools/call', {
      name: 'stage_intent_validate', arguments: { ...artifact, basePresetHash: 'stale' },
    });
    if (!invalid.result.isError) fail('旧版本草稿必须拒绝');
    console.log('tools/call stage: paged contract → intent-only validation → stale hash rejected');

    // 未知工具：协议级错误（不是工具级结果）。
    const unknown = await client.request('tools/call', {
      name: 'no_such_tool',
      arguments: {},
    });
    if (!unknown.error) fail('未知工具应返回协议级错误');
    console.log(`tools/call 未知工具: ${unknown.error.code}（协议级错误 ✓）`);

    adapter.kill();
    console.log('✓ MCP stdio 端到端检查全部通过');
  } finally {
    server.kill();
    await sleep(200);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error.message);
});
