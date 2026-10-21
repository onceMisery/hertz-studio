#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'plugin', 'ui', 'app.js');
const source = fs.readFileSync(appPath, 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('window.AiGrantSettings = (function () {');
const marker = '\n})();\n\nasync function chooseTransport()';
const end = source.indexOf(marker, start);
assert.ok(start >= 0 && end > start, 'AI grants module boundaries exist in app.js');
const moduleSource = source.slice(start, end + '\n})();'.length);

class FixtureNode {
  constructor(id) {
    this.id = id || '';
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  async fire(name) {
    const handler = this.listeners.get(name);
    if (handler) return handler({ target: this });
  }
  async click() {
    assert.equal(this.disabled, false, this.textContent + ' should be enabled');
    return this.fire('click');
  }
}

function collect(root, predicate, out) {
  if (predicate(root)) out.push(root);
  root.children.forEach((child) => collect(child, predicate, out));
  return out;
}

function textContent(root) {
  return [root.textContent, ...root.children.map(textContent)].join('\n');
}

function createHarness(mode) {
  const ids = [
    'ai-grant-manager', 'ai-grant-unavailable', 'ai-grant-settings', 'ai-grant-label',
    'ai-grant-preset', 'ai-grant-scope-groups', 'ai-grant-create', 'ai-grant-refresh',
    'ai-grant-command', 'ai-grant-status', 'ai-grant-list',
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FixtureNode(id)]));
  const scopeInputs = [
    'playback:read', 'playback:pause', 'playback:resume', 'playback:previous',
    'playback:next', 'playback:seek', 'playback:volume_set', 'library:read',
    'stage:capabilities_read', 'stage:intent_validate',
  ].map((scope) => {
    const input = new FixtureNode();
    input.dataset.aiScope = scope;
    return input;
  });
  nodes['ai-grant-scope-groups'].querySelectorAll = () => scopeInputs;
  nodes['ai-grant-preset'].value = 'snapshot';
  nodes['ai-grant-command'].value = 'hertz-studio.exe';

  const rows = [];
  const writes = [];
  const copied = [];
  const confirmations = [];
  let failNextList = false;
  let nextId = 1;
  const privateValue = 'fixture-secret-must-never-be-rendered';
  const serverSummary = (grant) => Object.assign({}, grant, {
    secret: privateValue,
    bearer_token: privateValue,
    api_key: privateValue,
  });
  const transport = {
    kind: () => mode || 'server',
    async get(route) {
      assert.equal(route, '/v1/ai/grants');
      if (failNextList) {
        failNextList = false;
        throw new Error('fixture list refresh failed');
      }
      return { grants: rows.map(serverSummary) };
    },
    async post(route, body) {
      writes.push({ method: 'POST', route, body: JSON.parse(JSON.stringify(body)) });
      if (route === '/v1/ai/grants') {
        const id = 'fixture-grant-' + nextId++;
        const row = {
          grant_id: id,
          label: body.label,
          scopes: body.scopes,
          revoked: false,
          created_at: 100,
          updated_at: 100,
          credential_path: 'D:\\fixture-data\\ai\\grants\\' + id + '.key',
        };
        rows.unshift(row);
        return serverSummary(row);
      }
      const match = route.match(/^\/v1\/ai\/grants\/([^/]+)\/rotate$/);
      assert.ok(match, 'only the documented rotate route is used');
      const row = rows.find((item) => item.grant_id === decodeURIComponent(match[1]));
      assert.ok(row && !row.revoked);
      row.updated_at += 1;
      return serverSummary(row);
    },
    async del(route) {
      writes.push({ method: 'DELETE', route });
      const match = route.match(/^\/v1\/ai\/grants\/([^/]+)$/);
      assert.ok(match, 'only the documented revoke route is used');
      const row = rows.find((item) => item.grant_id === decodeURIComponent(match[1]));
      assert.ok(row);
      row.revoked = true;
      row.credential_path = '';
      failNextList = true;
      return serverSummary(row);
    },
  };
  const document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => new FixtureNode(),
  };
  const window = {};
  vm.runInNewContext(moduleSource, { window, document }, { filename: appPath });
  window.AiGrantSettings.init({
    transport,
    isDbx: mode === 'dbx',
    confirm: async (message) => { confirmations.push(message); return true; },
    copy: async (value) => { copied.push(value); },
  });
  return { nodes, scopeInputs, rows, writes, copied, confirmations, privateValue, window };
}

async function main() {
  const defaultFixture = createHarness('server');
  await new Promise((resolve) => setTimeout(resolve, 0));
  defaultFixture.nodes['ai-grant-label'].value = 'Snapshot Assistant';
  await defaultFixture.nodes['ai-grant-create'].click();
  assert.deepEqual(defaultFixture.writes.find((write) => write.route === '/v1/ai/grants').body, {
    label: 'Snapshot Assistant',
    scopes: ['playback:read'],
  }, 'the initially selected snapshot preset is applied before the first submit');

  const fixture = createHarness('server');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fixture.nodes['ai-grant-manager'].hidden, false);
  fixture.nodes['ai-grant-label'].value = '  Local Assistant  ';
  fixture.nodes['ai-grant-preset'].value = 'control';
  await fixture.nodes['ai-grant-preset'].fire('change');
  await fixture.nodes['ai-grant-create'].click();

  const create = fixture.writes.find((write) => write.route === '/v1/ai/grants');
  assert.deepEqual(create.body, {
    label: 'Local Assistant',
    scopes: [
      'playback:read', 'playback:pause', 'playback:resume', 'playback:previous',
      'playback:next', 'playback:seek', 'playback:volume_set',
    ],
  });
  assert.equal(fixture.rows.length, 1);

  let rendered = textContent(fixture.nodes['ai-grant-list']);
  assert.ok(rendered.includes('Local Assistant'));
  assert.ok(!rendered.includes(fixture.privateValue), 'unknown response fields never enter rendered content');
  const article = fixture.nodes['ai-grant-list'].children.find((child) => child.className === 'ai-grant-item');
  const copyButton = collect(article, (node) => node.textContent === '复制 MCP 配置', [])[0];
  assert.ok(copyButton);
  await copyButton.click();
  const copiedConfig = JSON.parse(fixture.copied[0]);
  assert.equal(copiedConfig.mcpServers['hertz-studio'].command, 'hertz-studio.exe');
  assert.deepEqual(copiedConfig.mcpServers['hertz-studio'].args, [
    '--mcp-stdio', '--data-dir', 'D:\\fixture-data', '--grant', 'fixture-grant-1',
  ]);
  assert.ok(!fixture.copied[0].includes(fixture.privateValue));

  const rotateButton = collect(article, (node) => node.textContent === '轮换凭据', [])[0];
  assert.ok(rotateButton);
  await rotateButton.click();
  assert.ok(fixture.writes.some((write) => write.route === '/v1/ai/grants/fixture-grant-1/rotate'));
  assert.ok(fixture.confirmations.some((message) => message.includes('旧凭据会立即失效')));

  const currentArticle = fixture.nodes['ai-grant-list'].children.find((child) => child.className === 'ai-grant-item');
  const revokeButton = collect(currentArticle, (node) => node.textContent === '撤销授权', [])[0];
  assert.ok(revokeButton);
  await revokeButton.click();
  rendered = textContent(fixture.nodes['ai-grant-list']);
  assert.ok(rendered.includes('已撤销'), 'successful revoke remains visible when the follow-up list read fails');
  assert.ok(fixture.nodes['ai-grant-status'].textContent.includes('列表刷新失败'));
  assert.ok(!collect(fixture.nodes['ai-grant-list'], (node) => node.textContent === '撤销授权' || node.textContent === '轮换凭据', []).length);
  assert.ok(fixture.writes.some((write) => write.method === 'DELETE' && write.route === '/v1/ai/grants/fixture-grant-1'));

  const dbx = createHarness('dbx');
  assert.equal(dbx.nodes['ai-grant-manager'].hidden, true);
  assert.ok(dbx.nodes['ai-grant-unavailable'].textContent.includes('DBX'));
  const demo = createHarness('demo');
  assert.equal(demo.nodes['ai-grant-manager'].hidden, true);
  assert.ok(demo.nodes['ai-grant-unavailable'].textContent.includes('未连接'));

  console.log('AI grants UI fixture passed: create scopes, safe summary, MCP config, rotate, revoke-after-refresh-failure, DBX and demo states.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
